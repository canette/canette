package registry

import (
	"context"
	"encoding/json"
	"fmt"
)

// Config holds registry configuration from environment variables
type Config struct {
	ImageRepo string // Full IMAGE_REPO value (e.g., "123456.dkr.ecr.us-east-1.amazonaws.com/canette/")
	AuthType  string // "irsa" or "static"
}

// Provider handles registry-specific operations
type Provider interface {
	// EnsureRepository creates the repository if it doesn't exist
	// Returns nil if already exists or successfully created
	EnsureRepository(ctx context.Context, repoName string) error

	// GetAuthConfig returns Docker config.json auth entry for this registry
	// Returns nil if using workload identity (IRSA)
	GetAuthConfig(ctx context.Context) (*AuthConfig, error)
}

// AuthConfig represents Docker registry authentication
type AuthConfig struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// DockerConfigJSON represents the ~/.docker/config.json structure
type DockerConfigJSON struct {
	Auths map[string]AuthConfig `json:"auths"`
}

// NewProvider creates a provider based on auto-detected type
func NewProvider(cfg Config) (Provider, error) {
	provider := DetectProvider(cfg.ImageRepo)

	switch provider {
	case "ecr":
		region, err := ParseECRRegion(cfg.ImageRepo)
		if err != nil {
			return nil, fmt.Errorf("parse ECR region: %w", err)
		}
		return NewECRProvider(cfg.ImageRepo, region, cfg.AuthType)

	case "dockerhub", "digitalocean", "generic":
		// Generic provider works for all non-ECR registries
		return NewGenericProvider(cfg.ImageRepo), nil

	default:
		return nil, fmt.Errorf("unknown registry provider: %s", provider)
	}
}

// BuildDockerConfigJSON creates a Docker config.json for BuildKit.
// imageRepo may include a path prefix (e.g. "host.example.com/org/"); only
// the hostname is used as the auths key so Docker and buildctl can match it.
func BuildDockerConfigJSON(imageRepo string, auth *AuthConfig) (string, error) {
	if auth == nil {
		// IRSA: return empty config, credentials come from environment
		return "{}", nil
	}

	config := DockerConfigJSON{
		Auths: map[string]AuthConfig{
			ExtractRegistryURL(imageRepo): *auth,
		},
	}

	jsonBytes, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("marshal docker config: %w", err)
	}

	return string(jsonBytes), nil
}
