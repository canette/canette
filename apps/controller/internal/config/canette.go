// Package config parses the runtime part of canette.yaml used by the
// controller. The file format itself is defined in canette.dev/lib/canetteyaml,
// shared with the builder and the published JSON Schema. Build-time fields
// (context, dockerfile, args) are handled exclusively by the builder.
package config

import (
	"errors"
	"strings"

	"canette.dev/lib/canetteyaml"
	"gopkg.in/yaml.v3"
)

// CanetteRuntimeConfig is the subset of canette.yaml that affects how the
// controller generates Kubernetes resources. All fields are optional.
type CanetteRuntimeConfig = canetteyaml.RuntimeConfig

// HealthcheckSpec maps to the canette.yaml healthcheck block. A nil pointer
// on the outer config means the block is absent (no probe generated) —
// distinct from a present-but-empty block, which applies defaults.
// canette.yaml is the only source for this: there is no DB-stored default
// (unlike port/replicas/resources).
type HealthcheckSpec = canetteyaml.HealthcheckSpec

// ParseRuntimeConfig parses a canette.yaml YAML string. Unknown fields are
// silently ignored for forward compatibility. Returns a zero-value struct
// (not an error) for empty input.
func ParseRuntimeConfig(yamlStr string) (CanetteRuntimeConfig, error) {
	var cfg CanetteRuntimeConfig
	if yamlStr == "" {
		return cfg, nil
	}
	if err := yaml.Unmarshal([]byte(yamlStr), &cfg); err != nil {
		return CanetteRuntimeConfig{}, err
	}
	return cfg, nil
}

// Hardening is the resolved hardened-mode configuration for an app, with the
// defaults applied. nil means hardened mode is off.
type Hardening struct {
	User           int64 // UID, GID and fsGroup
	ReadOnlyRootFS bool
	// WritablePaths are emptyDir mounts, only used when ReadOnlyRootFS.
	WritablePaths []string
}

// SecurityError is an invalid canette.yaml security block. Unlike other
// canette.yaml errors it fails the deployment: deploying without the
// hardening the user asked for would be silently less secure.
type SecurityError struct {
	Msg string
}

func (e *SecurityError) Error() string { return e.Msg }

// ResolveSecurity reads and validates the security block of a canette.yaml
// string and applies the hardened-mode defaults. It decodes only that block,
// so a type error elsewhere in the file can't hide it, and vice versa. It
// returns warnings for settings that have no effect.
//
// A file that isn't valid YAML at all is not a SecurityError: the security
// block can't be read, and the caller's general parse warning applies.
func ResolveSecurity(yamlStr string) (*Hardening, []string, error) {
	if yamlStr == "" {
		return nil, nil, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(yamlStr), &doc); err != nil {
		return nil, nil, nil
	}
	var wrapper struct {
		Security *canetteyaml.SecuritySpec `yaml:"security"`
	}
	if err := doc.Decode(&wrapper); err != nil {
		var typeErr *yaml.TypeError
		if errors.As(err, &typeErr) {
			// Not from SecuritySpec.UnmarshalYAML, e.g. the file is a list.
			return nil, nil, nil
		}
		return nil, nil, &SecurityError{Msg: err.Error()}
	}
	s := wrapper.Security
	if s == nil {
		return nil, nil, nil
	}
	if err := s.Validate(); err != nil {
		return nil, nil, &SecurityError{Msg: err.Error()}
	}

	if s.Hardened == nil || !*s.Hardened {
		var ignored []string
		if s.WritablePaths != nil {
			ignored = append(ignored, "security.writable_paths")
		}
		if s.ReadOnlyRootFilesystem != nil {
			ignored = append(ignored, "security.read_only_root_filesystem")
		}
		if s.User != nil {
			ignored = append(ignored, "security.user")
		}
		if len(ignored) == 0 {
			return nil, nil, nil
		}
		return nil, []string{strings.Join(ignored, ", ") + " ignored because security.hardened is not true"}, nil
	}

	h := &Hardening{
		User:           canetteyaml.DefaultHardenedUser,
		ReadOnlyRootFS: s.ReadOnlyRootFilesystem == nil || *s.ReadOnlyRootFilesystem,
	}
	if s.User != nil {
		h.User = *s.User
	}
	var warnings []string
	switch {
	case !h.ReadOnlyRootFS:
		if len(s.WritablePaths) > 0 {
			warnings = append(warnings, "security.writable_paths ignored because security.read_only_root_filesystem is false")
		}
	case s.WritablePaths == nil:
		h.WritablePaths = []string{"/tmp"}
	default:
		h.WritablePaths = s.WritablePaths
	}
	return h, warnings, nil
}
