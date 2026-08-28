// Package config defines the canette.yaml runtime schema used by the controller.
// Only runtime-relevant fields are included — build-time fields (context,
// dockerfile, args) are handled exclusively by the builder.
package config

import (
	"gopkg.in/yaml.v3"
)

// CanetteRuntimeConfig is the subset of canette.yaml that affects how the
// controller generates Kubernetes resources. All fields are optional.
type CanetteRuntimeConfig struct {
	Resources   ResourceConfig    `yaml:"resources"`
	Replicas    *int              `yaml:"replicas"`
	Runtime     RuntimeSpec       `yaml:"runtime"`
	Ingress     IngressSpec       `yaml:"ingress"`
	Env         map[string]string `yaml:"env"`
	Healthcheck *HealthcheckSpec  `yaml:"healthcheck"`
}

// HealthcheckSpec maps to the canette.yaml healthcheck block. A nil pointer
// on the outer config means the block is absent (no probe generated, today's
// behavior) — distinct from a present-but-empty block, which applies
// defaults. canette.yaml is currently the ONLY source for this — there is no
// DB-stored default (unlike port/replicas/resources), so an app with no
// healthcheck in its repo gets no probe at all.
type HealthcheckSpec struct {
	Path         string `yaml:"path"`
	Port         *int   `yaml:"port"`
	InitialDelay *int   `yaml:"initial_delay"`
	Period       *int   `yaml:"period"`
}

// ResourceConfig maps to the canette.yaml resources block.
type ResourceConfig struct {
	Requests ResourceValues `yaml:"requests"`
	Limits   ResourceValues `yaml:"limits"`
}

// ResourceValues holds CPU and memory quantities as strings (e.g. "100m", "128Mi").
type ResourceValues struct {
	CPU    string `yaml:"cpu"`
	Memory string `yaml:"memory"`
}

// RuntimeSpec maps to the canette.yaml runtime block.
type RuntimeSpec struct {
	Port    *int     `yaml:"port"`
	Command []string `yaml:"command"`
}

// IngressSpec maps to the canette.yaml ingress block.
type IngressSpec struct {
	Enabled *bool  `yaml:"enabled"`
	Host    string `yaml:"host"`
	Path    string `yaml:"path"`
}

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
