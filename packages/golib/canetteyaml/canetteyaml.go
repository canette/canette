// Package canetteyaml is the single definition of the canette.yaml file format.
//
// The controller decodes RuntimeConfig, the builder decodes BuildConfig, and
// Config (both together) is what the published JSON Schema is generated from
// (tools/canette-schema). Doc comments on these types become the schema's field
// descriptions, so write them for someone who has not read the docs. A new
// canette.yaml field must be added here, then the schema regenerated with
// `bun run generate:schema`.
//
// All fields are optional: absence means "use platform defaults". Unknown
// fields are ignored for forward compatibility.
package canetteyaml

// Config is a complete canette.yaml file.
type Config struct {
	BuildConfig   `yaml:",inline"`
	RuntimeConfig `yaml:",inline"`

	// Names of the secrets the app expects, for documentation only. Secret
	// values are never stored in canette.yaml: set them in the canette UI or
	// API, where they are encrypted at rest and injected as environment
	// variables at deploy time.
	Secrets []string `yaml:"secrets,omitempty" jsonschema:"example=DATABASE_URL"`
}

// BuildConfig is the build-time part of canette.yaml, read by the builder from
// the app's stored canette config (base) and the repository's canette.yaml
// (override).
type BuildConfig struct {
	// How the container image is built from a Git repository. A canette.yaml
	// committed to the repository wins field by field over the app's stored
	// canette config. No effect for apps deployed from a container image.
	Build BuildSpec `yaml:"build,omitempty"`
}

// BuildSpec controls how the image is built. Without a dockerfile, railpack
// detects the language and framework and builds the image automatically.
type BuildSpec struct {
	// Build context directory, relative to the app root (the app path in the
	// repository). Defaults to ".".
	Context string `yaml:"context,omitempty" jsonschema:"example=.,example=./src"`
	// Path to a Dockerfile, relative to the app root. When set, the image is
	// built from this Dockerfile instead of railpack auto-detection.
	Dockerfile string `yaml:"dockerfile,omitempty" jsonschema:"example=Dockerfile"`
	// Build-time ARG values passed to the Dockerfile build (at most 32). Keys
	// must be valid Dockerfile ARG names. Not available to the running app:
	// use env for runtime variables.
	Args map[string]string `yaml:"args,omitempty"`
}

// RuntimeConfig is the runtime part of canette.yaml, read by the controller
// when it generates the app's Kubernetes resources. For each field, a value in
// canette.yaml wins over the value set in the canette UI.
type RuntimeConfig struct {
	// How the app's container runs.
	Runtime RuntimeSpec `yaml:"runtime,omitempty"`
	// Plaintext environment variables, safe to commit. Merged on top of the
	// env vars set in the canette UI (canette.yaml wins on conflicts). Use
	// secrets in the UI for sensitive values. PORT is reserved: canette sets
	// it from runtime.port.
	Env map[string]string `yaml:"env,omitempty"`
	// CPU and memory requests and limits for the app's container, as
	// Kubernetes quantities. Fields left out fall back to the platform
	// defaults set by the canette admin (100m/128Mi requests and 500m/512Mi
	// limits out of the box).
	Resources ResourceConfig `yaml:"resources,omitempty"`
	// Number of pods to run, from 1 to 20 (higher values are capped at 20).
	// Defaults to 1.
	Replicas *int `yaml:"replicas,omitempty" jsonschema:"minimum=1,maximum=20,default=1"`
	// HTTP readiness probe for the app's container. While it fails, the pod
	// gets no traffic, but it is never restarted. Without this block no probe
	// is configured. An empty block (healthcheck: {}) enables the probe with
	// the defaults below.
	Healthcheck *HealthcheckSpec `yaml:"healthcheck,omitempty"`
	// Public HTTP routing for a web app.
	Ingress IngressSpec `yaml:"ingress,omitempty"`
}

// RuntimeSpec configures how the app's container runs.
type RuntimeSpec struct {
	// Port the app listens on inside the container. canette also sets the PORT
	// environment variable to this value. Overrides the port set in the UI.
	Port *int `yaml:"port,omitempty" jsonschema:"minimum=1,maximum=65535,example=3000"`
	// Command that starts the app, as a list of arguments. Replaces the
	// image's default entrypoint and command.
	Command []string `yaml:"command,omitempty" jsonschema:"example=node,example=server.js"`
}

// ResourceConfig holds the container's resource requests and limits.
type ResourceConfig struct {
	// Resources reserved for the container; used by Kubernetes for scheduling.
	Requests ResourceValues `yaml:"requests,omitempty"`
	// Maximum resources the container may use. Exceeding the memory limit
	// restarts the container; CPU is throttled.
	Limits ResourceValues `yaml:"limits,omitempty"`
}

// ResourceValues holds CPU and memory as Kubernetes quantities.
type ResourceValues struct {
	// CPU as a Kubernetes quantity, e.g. "100m" (0.1 core) or 1.
	CPU Quantity `yaml:"cpu,omitempty" jsonschema:"example=100m,example=500m"`
	// Memory as a Kubernetes quantity, e.g. "128Mi" or "1Gi" (binary units),
	// or a plain number of bytes. "MB"/"GB" are not valid: use "M"/"G" or
	// "Mi"/"Gi".
	Memory Quantity `yaml:"memory,omitempty" jsonschema:"example=128Mi,example=512Mi"`
}

// Quantity is a Kubernetes resource quantity. In YAML it may be a string
// ("100m", "1Gi") or a bare number (1, 0.5, 1073741824); both decode to the
// same string, which Kubernetes validates when the app is deployed.
type Quantity string

// HealthcheckSpec configures the HTTP probe.
type HealthcheckSpec struct {
	// HTTP path that returns a 2xx or 3xx status when the app is healthy.
	// Defaults to "/".
	Path string `yaml:"path,omitempty" jsonschema:"example=/healthz"`
	// Port to probe. Defaults to the app's port.
	Port *int `yaml:"port,omitempty" jsonschema:"minimum=1,maximum=65535"`
	// Seconds to wait after the container starts before the first probe.
	// Defaults to 5.
	InitialDelay *int `yaml:"initial_delay,omitempty" jsonschema:"minimum=0,default=5"`
	// Seconds between probes. Defaults to 10.
	Period *int `yaml:"period,omitempty" jsonschema:"minimum=1,default=10"`
}

// IngressSpec configures public HTTP routing.
type IngressSpec struct {
	// Whether the app gets a public URL. false keeps the app reachable inside
	// the cluster through its Service but creates no HTTPRoute, the same as
	// the "private" deployment type. Defaults to true for web apps.
	Enabled *bool `yaml:"enabled,omitempty"`
}
