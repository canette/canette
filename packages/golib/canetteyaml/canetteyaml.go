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
	// Opt-in container hardening. Off unless security.hardened is true.
	Security *SecuritySpec `yaml:"security,omitempty"`
}

// SecuritySpec configures hardened mode, an opinionated set of container
// security settings that is off by default because it needs a compatible
// image.
type SecuritySpec struct {
	// Turns on hardened mode. The app container then runs as a non-root user
	// (UID and GID 10001 unless user is set), with a read-only root filesystem
	// (only writable_paths are writable) and all Linux capabilities dropped.
	// Volumes are made writable for that user through the pod's fsGroup.
	// Works for most app images, including railpack builds, whose files only
	// need to be world-readable. Breaks images that need root at startup.
	// Whether a port below 1024 (such as the default nginx image's port 80)
	// works depends on the cluster's container runtime, so use a port of 1024
	// or higher, for example nginxinc/nginx-unprivileged on port 8080.
	// Directories the app writes to must be listed in
	// writable_paths or be a canette volume. Defaults to false.
	Hardened *bool `yaml:"hardened,omitempty" jsonschema:"default=false"`
	// Absolute directories that stay writable on top of the read-only root
	// filesystem. Each one is an empty, pod-local directory (Kubernetes
	// emptyDir) whose contents are lost when the pod restarts, and hides what
	// the image has at that path. Defaults to ["/tmp"]; an empty list means no
	// writable directories. A volume configured in canette on the same path
	// takes precedence. Only used when hardened is true and
	// read_only_root_filesystem is not false.
	WritablePaths []string `yaml:"writable_paths,omitempty" jsonschema:"example=/tmp,example=/app/.next/cache"`
	// Set to false to keep the root filesystem writable in hardened mode, for
	// apps that write in many places. The other hardened settings still
	// apply. Defaults to true. Only used when hardened is true.
	ReadOnlyRootFilesystem *bool `yaml:"read_only_root_filesystem,omitempty" jsonschema:"default=true"`
	// UID and GID the container runs as in hardened mode, also used as the
	// pod's fsGroup. Overrides the image's USER. Set it to the image's own
	// non-root UID when the app's files are not readable by other users.
	// Must not be 0 (root). Defaults to 10001. Only used when hardened is
	// true.
	User *int64 `yaml:"user,omitempty" jsonschema:"default=10001,example=1000"`
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
