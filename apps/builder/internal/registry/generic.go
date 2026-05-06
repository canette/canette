package registry

import (
	"context"
)

// GenericProvider for registries that don't need pre-creation (DockerHub, Harbor, etc.)
type GenericProvider struct {
	imageRepo string
}

// NewGenericProvider creates a new generic registry provider
func NewGenericProvider(imageRepo string) *GenericProvider {
	return &GenericProvider{
		imageRepo: imageRepo,
	}
}

// EnsureRepository is a no-op for generic registries
// Generic registries typically allow push-on-first-write
func (p *GenericProvider) EnsureRepository(ctx context.Context, repoName string) error {
	// No pre-creation needed
	return nil
}

// GetAuthConfig returns nil to indicate auth is handled externally
// Generic registries use existing REGISTRY_AUTH_SECRET mechanism
func (p *GenericProvider) GetAuthConfig(ctx context.Context) (*AuthConfig, error) {
	// Return nil to indicate auth is handled externally via REGISTRY_AUTH_SECRET
	return nil, nil
}
