// git-init clones a git repository into a workspace directory.
// It replaces the inline shell script that previously ran in the init container.
// All inputs come from environment variables — args are passed as discrete exec
// arguments so user-supplied values are never shell-interpolated.
package main

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	// refRe allows branch names, tags, and short SHAs.
	// Starts with alphanumeric; allows dots, underscores, hyphens, slashes.
	refRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,249}$`)

	// sshURLRe matches git@host:path/repo or git@host:path/repo.git
	sshURLRe = regexp.MustCompile(`^git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]+$`)
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "git-init: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	gitURL := os.Getenv("GIT_URL")
	gitRef := os.Getenv("GIT_REF")
	credType := os.Getenv("GIT_CREDENTIAL_TYPE")
	workspace := os.Getenv("WORKSPACE")
	if workspace == "" {
		workspace = "/workspace"
	}
	workspace = filepath.Clean(workspace)
	sourcePath := filepath.Join(workspace, "source")
	configPath := filepath.Join(workspace, "config")

	if err := validateURL(gitURL); err != nil {
		return err
	}
	if err := validateRef(gitRef); err != nil {
		return err
	}
	switch credType {
	case "none", "pat", "ssh_key":
	default:
		return fmt.Errorf("GIT_CREDENTIAL_TYPE must be none, pat, or ssh_key (got %q)", credType)
	}

	cloneURL, credEnv, err := setupCredentials(credType, gitURL)
	if err != nil {
		return fmt.Errorf("credential setup: %w", err)
	}

	if err := os.Mkdir(configPath, 0755); err != nil {
		return fmt.Errorf("create directory %s setup: %w", configPath, err)
	}

	fmt.Printf("Cloning %s at ref %s\n", gitURL, gitRef)
	cloneCmd := exec.Command("git", "clone", "--depth=1", "--branch", gitRef, cloneURL, sourcePath)
	cloneCmd.Env = append(os.Environ(), credEnv...)
	cloneCmd.Stdout = os.Stdout
	cloneCmd.Stderr = os.Stderr
	if err := cloneCmd.Run(); err != nil {
		return fmt.Errorf("git clone: %w", err)
	}

	shaOut, err := exec.Command("git", "-C", sourcePath, "rev-parse", "HEAD").Output()
	if err != nil {
		return fmt.Errorf("git rev-parse: %w", err)
	}
	sha := strings.TrimSpace(string(shaOut))

	if err := os.WriteFile(filepath.Join(configPath, ".can-commit-sha"), []byte(sha), 0644); err != nil {
		return fmt.Errorf("write sha file: %w", err)
	}

	fmt.Printf("CAN_COMMIT_SHA=%s\n", sha)
	return nil
}

func validateURL(u string) error {
	if u == "" {
		return fmt.Errorf("GIT_URL is required")
	}
	if sshURLRe.MatchString(u) {
		return nil
	}
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "ssh") {
		return fmt.Errorf("GIT_URL must be an https://, ssh://, or git@host:path URL")
	}
	// Reject shell-special characters that have no place in a git URL.
	for _, ch := range []string{";", "|", "&", "`", "$", "<", ">", "(", ")", "{", "}", "\n", "\r"} {
		if strings.Contains(u, ch) {
			return fmt.Errorf("GIT_URL contains invalid character %q", ch)
		}
	}
	return nil
}

func validateRef(ref string) error {
	if ref == "" {
		return fmt.Errorf("GIT_REF is required")
	}
	if !refRe.MatchString(ref) {
		return fmt.Errorf("GIT_REF %q contains invalid characters (alphanumeric, ., _, /, - only)", ref)
	}
	if strings.Contains(ref, "..") {
		return fmt.Errorf("GIT_REF must not contain ..")
	}
	return nil
}

// setupCredentials returns the clone URL (possibly with embedded credentials)
// and any extra environment variables the git command needs.
// No credentials are written to the filesystem — the credential volume is read
// directly (SSH) or embedded in the URL (PAT).
func setupCredentials(credType, gitURL string) (cloneURL string, extraEnv []string, err error) {
	cloneURL = gitURL
	switch credType {
	case "pat":
		tokenBytes, err := os.ReadFile("/git-credentials/token")
		if err != nil {
			return "", nil, fmt.Errorf("read PAT token: %w", err)
		}
		token := strings.TrimSpace(string(tokenBytes))

		// Pass the token as an HTTP Authorization header via GIT_CONFIG_* env vars.
		// This keeps the clone URL credential-free so git never echoes the token
		// in error messages. Requires git >= 2.32 (GIT_CONFIG_COUNT support).
		// Basic auth encoding (x-access-token:TOKEN) works for GitHub PATs,
		// GitHub App tokens, GitLab PATs, Gitea tokens, and generic HTTP git servers.
		encoded := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
		extraEnv = []string{
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=http.extraheader",
			"GIT_CONFIG_VALUE_0=Authorization: Basic " + encoded,
		}
		// cloneURL stays as the plain gitURL — token never touches the URL

	case "ssh_key":
		sshCmd := "ssh -i /git-credentials/id_ed25519 -F /dev/null"
		if _, statErr := os.Stat("/git-credentials/known_hosts"); statErr == nil {
			sshCmd += " -o UserKnownHostsFile=/git-credentials/known_hosts -o StrictHostKeyChecking=yes"
		} else {
			sshCmd += " -o StrictHostKeyChecking=accept-new"
		}
		extraEnv = []string{"GIT_SSH_COMMAND=" + sshCmd}
	}
	return cloneURL, extraEnv, nil
}
