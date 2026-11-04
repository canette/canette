// Package config parses the runtime part of canette.yaml used by the
// controller. The file format itself is defined in canette.dev/lib/canetteyaml,
// shared with the builder and the published JSON Schema. Build-time fields
// (context, dockerfile, args) are handled exclusively by the builder.
package config

import (
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
