// canette-build runs the image build step inside the build Job container.
// It replaces the inline shell script that previously ran in the main container.
// Inputs come from environment variables. buildctl and railpack are invoked
// via exec — args are discrete strings, never shell-interpolated.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"canette.dev/builder/internal/config"
)

var (
	appNameRe      = regexp.MustCompile(`^[a-z0-9-]+/[a-z0-9-]+$`)
	imageTagRe     = regexp.MustCompile(`^git-[a-f0-9]{7}$`)
	buildkitAddrRe = regexp.MustCompile(`^(tcp://[a-zA-Z0-9._-]+(:\d{1,5})?|unix://[a-zA-Z0-9._/:-]+)$`)
)

// buildMetadata is the subset of buildctl's --metadata-file output we care about.
type buildMetadata struct {
	Digest string `json:"containerimage.digest"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "canette-build: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	appName := os.Getenv("APP_NAME")
	appPath := os.Getenv("APP_PATH")
	imageRepo := os.Getenv("IMAGE_REPO")
	buildkitHost := os.Getenv("BUILDKIT_HOST")
	workspace := os.Getenv("WORKSPACE")
	if workspace == "" {
		workspace = "/workspace"
	}
	workspace = filepath.Clean(workspace)
	sourcePath := filepath.Join(workspace, "source")
	configPath := filepath.Join(workspace, "config")

	imageTag, err := readImageTag(configPath)
	if err != nil {
		return err
	}

	if err := validateInputs(appName, imageRepo, imageTag, buildkitHost); err != nil {
		return err
	}

	// Resolve and contain the app path within the workspace.
	workPath, err := resolveAppPath(sourcePath, appPath)
	if err != nil {
		return err
	}

	fullImage := imageRepo + appName + ":" + imageTag
	fmt.Printf("CAN_IMAGE_REF=%s\n", fullImage)

	// Read UI config (base layer) injected from deployments.canette_config.
	// Parse errors are silently ignored — treat missing/invalid UI config as zero value.
	var uiCfg config.CanetteConfig
	if envB64 := os.Getenv("CANETTE_CONFIG"); envB64 != "" {
		if decoded, decErr := base64.StdEncoding.DecodeString(envB64); decErr == nil {
			var parseErr error
			uiCfg, parseErr = config.ParseBytes(decoded)
			if parseErr != nil {
				fmt.Fprintf(os.Stderr, "warning: could not parse CANETTE_CONFIG: %v\n", parseErr)
			}
		}
	}

	// Parse the repo's canette.yaml as the override layer.
	canetteYAMLPath := filepath.Join(workPath, "canette.yaml")
	repoCfg, err := config.ParseFile(canetteYAMLPath)
	if err != nil {
		return fmt.Errorf("canette.yaml: %w", err)
	}

	// Merge build config: repo fields win over UI fields.
	cfg := mergeBuildConfig(uiCfg, repoCfg)

	// Emit the repo's raw canette.yaml so the builder service can overwrite
	// deployments.canette_config (runtime fields: resources, replicas, etc.).
	// Only emitted when a repo canette.yaml exists — preserving the UI snapshot otherwise.
	if rawYAML, readErr := os.ReadFile(canetteYAMLPath); readErr == nil {
		fmt.Printf("CAN_CANETTE_CONFIG=%s\n", base64.StdEncoding.EncodeToString(rawYAML))
	}

	metaFile := "/tmp/build-metadata.json" // We are running in a container, this should be OK
	defer os.Remove(metaFile)

	if err := build(cfg, workPath, fullImage, buildkitHost, metaFile); err != nil {
		return err
	}

	digest, err := readDigest(metaFile)
	if err != nil {
		return err
	}

	fmt.Printf("CAN_IMAGE_DIGEST=%s\n", digest)
	fmt.Printf("Build done: %s@%s\n", fullImage, digest)
	return nil
}

func validateInputs(appName, imageRepo, imageTag, buildkitHost string) error {
	if !appNameRe.MatchString(appName) {
		return fmt.Errorf("APP_NAME must match project/app (got %q)", appName)
	}
	if imageRepo == "" {
		return fmt.Errorf("IMAGE_REPO is required")
	}
	for _, ch := range []string{";", "|", "&", "`", "$", "<", ">", "\n", "\r"} {
		if strings.Contains(imageRepo, ch) {
			return fmt.Errorf("IMAGE_REPO contains invalid character %q", ch)
		}
	}
	if !imageTagRe.MatchString(imageTag) {
		return fmt.Errorf("IMAGE_TAG must match git-<7hex> (got %q)", imageTag)
	}
	if !buildkitAddrRe.MatchString(buildkitHost) {
		return fmt.Errorf("BUILDKIT_HOST must be a tcp:// or unix:// address (got %q)", buildkitHost)
	}
	return nil
}

// resolveAppPath joins workspace and appPath, then verifies the result stays
// inside the workspace — preventing path traversal attacks.
// appPath must be a relative path; absolute paths are rejected outright.
func resolveAppPath(sourcePath, appPath string) (string, error) {
	if filepath.IsAbs(appPath) {
		return "", fmt.Errorf("APP_PATH must be a relative path (got %q)", appPath)
	}

	// Normalize ./docker -> docker etc.
	cleanPath := filepath.Clean(appPath)

	joined := filepath.Join(sourcePath, filepath.FromSlash(cleanPath))
	resolved := filepath.Clean(joined)
	if !strings.HasPrefix(resolved+string(filepath.Separator), sourcePath+string(filepath.Separator)) {
		return "", fmt.Errorf("APP_PATH %q escapes workspace", appPath)
	}
	return resolved, nil
}

func build(cfg config.CanetteConfig, workPath, fullImage, buildkitHost, metaFile string) error {
	switch {
	case cfg.Build.Dockerfile != "":
		return buildWithDockerfile(cfg, workPath, fullImage, buildkitHost, metaFile)
	case fileExists(filepath.Join(workPath, "Dockerfile")):
		return buildAutoDockerfile(workPath, fullImage, buildkitHost, metaFile)
	default:
		return buildWithRailpack(workPath, fullImage, buildkitHost, metaFile)
	}
}

func buildWithDockerfile(cfg config.CanetteConfig, workPath, fullImage, buildkitHost, metaFile string) error {
	// Resolve dockerfile path inside workPath, guard against traversal.
	dfPath, err := resolveAppPath(workPath, cfg.Build.Dockerfile)
	if err != nil {
		return fmt.Errorf("build.dockerfile: %w", err)
	}

	contextPath := workPath
	if cfg.Build.Context != "" {
		if contextPath, err = resolveAppPath(workPath, cfg.Build.Context); err != nil {
			return fmt.Errorf("build.context: %w", err)
		}
	}

	dfDir := filepath.Dir(dfPath)
	dfName := filepath.Base(dfPath)

	fmt.Printf("Building from Dockerfile %s...\n", dfPath)
	args := []string{
		"build",
		"--frontend=dockerfile.v0",
		"--local", "context=" + contextPath,
		"--local", "dockerfile=" + dfDir,
		"--opt", "filename=" + dfName,
		"--output", "type=image,name=" + fullImage + ",push=true",
		"--metadata-file", metaFile,
	}
	args = appendBuildArgs(args, cfg.Build.Args)
	return runBuildctl(buildkitHost, args)
}

// We should be able to just call buildWithDockerfile - later refactoring
func buildAutoDockerfile(workPath, fullImage, buildkitHost, metaFile string) error {
	fmt.Printf("Building from Dockerfile (auto-detected) %s...\n", fullImage)
	args := []string{
		"build",
		"--frontend=dockerfile.v0",
		"--local", "context=" + workPath,
		"--local", "dockerfile=" + workPath,
		"--output", "type=image,name=" + fullImage + ",push=true",
		"--metadata-file", metaFile,
	}
	return runBuildctl(buildkitHost, args)
}

func buildWithRailpack(workPath, fullImage, buildkitHost, metaFile string) error {
	planFile := "/tmp/railpack-plan.json" // running in a container — /tmp is safe
	defer os.Remove(planFile)

	fmt.Printf("Planning %s with railpack...\n", workPath)
	fmt.Printf("Destination image %s...\n", fullImage)

	// Refuse to build if a railpack.json is present in the app directory.
	// canette manages the build plan — a user-committed railpack.json could
	// override it in ways that bypass resource controls or inject unexpected behaviour.
	if fileExists(filepath.Join(workPath, "railpack.json")) {
		return fmt.Errorf("railpack.json found in build root: canette manages the build plan directly and does not support user-supplied railpack.json files — remove it from the repository to continue")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	prepareCmd := exec.CommandContext(ctx, "railpack", "prepare", workPath,
		"--plan-out", planFile,
		"--info-out", "/tmp/railpack-info.json",
	)
	// Minimal clean environment — railpack analyse only needs PATH and a writable
	// temp dir. This prevents job env vars (CANETTE_CONFIG, credentials, etc.)
	// from leaking into the railpack subprocess.
	prepareCmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/tmp",
		"TMPDIR=/tmp",
	}
	prepareCmd.Stdout = os.Stdout
	prepareCmd.Stderr = os.Stderr
	if err := prepareCmd.Run(); err != nil {
		return fmt.Errorf("railpack prepare: %w", err)
	}

	fmt.Printf("Building %s...\n", fullImage)
	args := []string{
		"build",
		"--frontend", "gateway.v0",
		"--opt", "source=ghcr.io/railwayapp/railpack-frontend",
		"--local", "context=" + workPath,
		"--local", "dockerfile=/tmp",
		"--opt", "filename=railpack-plan.json",
		"--output", "type=image,name=" + fullImage + ",push=true",
		"--metadata-file", metaFile,
	}
	return runBuildctl(buildkitHost, args)
}

func runBuildctl(buildkitHost string, args []string) error {
	cmd := exec.Command("buildctl", args...)
	cmd.Env = append(os.Environ(), "BUILDKIT_HOST="+buildkitHost)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// appendBuildArgs adds --opt build-arg:<KEY>=<VALUE> entries for each build arg.
// Keys and values are passed as a single --opt string; buildctl does not
// shell-interpret these values.
func appendBuildArgs(args []string, buildArgs map[string]string) []string {
	for k, v := range buildArgs {
		args = append(args, "--opt", "build-arg:"+k+"="+v)
	}
	return args
}

func readDigest(metaFile string) (string, error) {
	data, err := os.ReadFile(metaFile)
	if err != nil {
		return "", fmt.Errorf("read build metadata: %w", err)
	}
	var meta buildMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return "", fmt.Errorf("parse build metadata: %w", err)
	}
	if meta.Digest == "" {
		return "", fmt.Errorf("containerimage.digest not found in build metadata")
	}
	return meta.Digest, nil
}

// readImageTag reads the commit SHA written by the git-init container from
// <configPath>/.can-commit-sha and returns a "git-<7hex>" image tag.
func readImageTag(configPath string) (string, error) {
	shaBytes, err := os.ReadFile(filepath.Join(configPath, ".can-commit-sha"))
	if err != nil {
		return "", fmt.Errorf("read .can-commit-sha: %w", err)
	}
	sha := strings.TrimSpace(string(shaBytes))
	if len(sha) < 7 {
		return "", fmt.Errorf(".can-commit-sha contains an invalid SHA: %q", sha)
	}
	return "git-" + sha[:7], nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// mergeBuildConfig merges two CanetteConfigs for build-time use.
// Non-empty fields in override win over base; build.args are merged key-by-key
// with override values taking precedence.
func mergeBuildConfig(base, override config.CanetteConfig) config.CanetteConfig {
	result := base
	if override.Build.Dockerfile != "" {
		result.Build.Dockerfile = override.Build.Dockerfile
	}
	if override.Build.Context != "" {
		result.Build.Context = override.Build.Context
	}
	if len(override.Build.Args) > 0 {
		if result.Build.Args == nil {
			result.Build.Args = make(map[string]string)
		}
		for k, v := range override.Build.Args {
			result.Build.Args[k] = v
		}
	}
	return result
}
