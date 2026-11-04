// Package config parses the build-time part of canette.yaml. The file format
// itself is defined in canette.dev/lib/canetteyaml, shared with the controller
// and the published JSON Schema.
// Unknown fields are silently ignored for forward compatibility.
package config

import (
	"fmt"
	"os"

	"canette.dev/lib/canetteyaml"
	"gopkg.in/yaml.v3"
)

const maxCanetteYAMLSize = 5 * 1024 // 5 KB

// CanetteConfig is the build-time part of a canette.yaml file. Runtime fields
// are not decoded here, so a type error in them can't fail a build.
type CanetteConfig = canetteyaml.BuildConfig

// BuildSpec controls how the image is built.
type BuildSpec = canetteyaml.BuildSpec

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
	fmt.Printf("Parsing configuration from %s...\n", path)
	if err := yaml.NewDecoder(f).Decode(&cfg); err != nil {
		return CanetteConfig{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := cfg.Build.Validate(); err != nil {
		return CanetteConfig{}, err
	}
	return cfg, nil
}
