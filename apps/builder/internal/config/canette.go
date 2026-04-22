// Package config defines the canette.yaml schema.
// All fields are optional — absence means "use platform defaults".
// Unknown fields are silently ignored for forward compatibility.
package config

import (
	"fmt"
	"os"
	"regexp"

	"gopkg.in/yaml.v3"
)

const (
	maxBuildValueLen   = 1024
	maxCanetteYAMLSize = 5 * 1024 // 5 KB
	maxArgKeyLen       = 256
	maxArgCount        = 32
)

// safePathRe allows only characters that are safe in filesystem paths.
// Excludes shell metacharacters: ; | & ` $ < > ( ) { } \n \r etc.
var safePathRe = regexp.MustCompile(`^[a-zA-Z0-9./_-]*$`)

// argKeyRe matches valid Docker ARG names: letter or underscore, followed by
// letters, digits, or underscores. Matches the Dockerfile ARG name spec.
var argKeyRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// CanetteConfig is the top-level structure of a canette.yaml file.
type CanetteConfig struct {
	Build BuildSpec `yaml:"build"`
}

// BuildSpec controls how the image is built.
type BuildSpec struct {
	// Context is the build context path, relative to the app root. Defaults to ".".
	Context string `yaml:"context"`
	// Dockerfile is the path to the Dockerfile, relative to the app root.
	// When set, the Dockerfile frontend is used instead of railpack auto-detection.
	Dockerfile string `yaml:"dockerfile"`
	// Args are build-time ARG values passed to the Dockerfile build.
	Args map[string]string `yaml:"args"`
}

// ParseBytes parses and validates canette.yaml content from an in-memory byte
// slice. The caller is responsible for any size limit enforcement.
func ParseBytes(data []byte) (CanetteConfig, error) {
	var cfg CanetteConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return CanetteConfig{}, fmt.Errorf("invalid canette.yaml: %w", err)
	}
	if err := cfg.Build.Validate(); err != nil {
		return CanetteConfig{}, err
	}
	return cfg, nil
}

// ParseFile reads, size-checks, parses, and validates a canette.yaml file.
// Returns a zero-value CanetteConfig (not an error) if the file does not exist.
func ParseFile(path string) (CanetteConfig, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return CanetteConfig{}, nil
	}
	if err != nil {
		return CanetteConfig{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return CanetteConfig{}, fmt.Errorf("stat %s: %w", path, err)
	}
	if info.Size() > maxCanetteYAMLSize {
		return CanetteConfig{}, fmt.Errorf("canette.yaml exceeds maximum size of %d bytes", maxCanetteYAMLSize)
	}

	var cfg CanetteConfig
	fmt.Printf("Parsin configuration from %s...\n", path)
	if err := yaml.NewDecoder(f).Decode(&cfg); err != nil {
		return CanetteConfig{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := cfg.Build.Validate(); err != nil {
		return CanetteConfig{}, err
	}
	return cfg, nil
}

// Validate checks that all BuildSpec field values are safe to pass to BuildKit.
// Empty path values are allowed (they mean "use the default"). Returns an
// error if any value exceeds the max length or contains disallowed characters.
func (b BuildSpec) Validate() error {
	for _, f := range []struct{ name, value string }{
		{"dockerfile", b.Dockerfile},
		{"context", b.Context},
	} {
		if len(f.value) > maxBuildValueLen {
			return fmt.Errorf("build.%s exceeds maximum length of %d", f.name, maxBuildValueLen)
		}
		if f.value != "" && !safePathRe.MatchString(f.value) {
			return fmt.Errorf("build.%s contains invalid characters (only alphanumeric, ., /, _, - allowed)", f.name)
		}
	}

	if len(b.Args) > maxArgCount {
		return fmt.Errorf("build.args exceeds maximum of %d entries", maxArgCount)
	}
	for k, v := range b.Args {
		if !argKeyRe.MatchString(k) {
			return fmt.Errorf("build.args key %q is invalid: must match [a-zA-Z_][a-zA-Z0-9_]*", k)
		}
		if len(k) > maxArgKeyLen {
			return fmt.Errorf("build.args key %q exceeds maximum length of %d", k, maxArgKeyLen)
		}
		if len(v) > maxBuildValueLen {
			return fmt.Errorf("build.args value for %q exceeds maximum length of %d", k, maxBuildValueLen)
		}
	}
	return nil
}
