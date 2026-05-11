package builder

import (
	"testing"
	"time"

	"go.uber.org/zap"

	k8sjobs "canette.dev/builder/internal/k8s"
	"canette.dev/builder/internal/scanner"
)

func newTestBuilder(imageRepo, registryAuthType string) *Builder {
	return New(
		nil, // store — not used during construction
		nil, // k8s   — not used during construction
		k8sjobs.BuildConfig{
			ImageRepo:        imageRepo,
			RegistryAuthType: registryAuthType,
		},
		nil,                    // cryptoKey
		zap.NewNop(),
		time.Second,
		1,
		scanner.Config{},       // empty → NoneProvider
	)
}

func TestRegistryAuthTypeResolution(t *testing.T) {
	ecrRepo    := "123456789012.dkr.ecr.us-east-1.amazonaws.com/canette/"
	genericRepo := "registry.example.com/canette/"

	tests := []struct {
		name             string
		imageRepo        string
		registryAuthType string // empty = auto-detect
		wantAuthType     string
	}{
		{
			name:         "ECR URL auto-detects irsa",
			imageRepo:    ecrRepo,
			wantAuthType: "irsa",
		},
		{
			name:         "non-ECR URL auto-detects static",
			imageRepo:    genericRepo,
			wantAuthType: "static",
		},
		{
			name:             "explicit irsa overrides ECR auto-detect",
			imageRepo:        ecrRepo,
			registryAuthType: "irsa",
			wantAuthType:     "irsa",
		},
		{
			name:             "explicit static overrides ECR auto-detect",
			imageRepo:        ecrRepo,
			registryAuthType: "static",
			wantAuthType:     "static",
		},
		{
			name:             "explicit irsa overrides non-ECR auto-detect",
			imageRepo:        genericRepo,
			registryAuthType: "irsa",
			wantAuthType:     "irsa",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := newTestBuilder(tc.imageRepo, tc.registryAuthType)

			if got := b.cfg.RegistryAuthType; got != tc.wantAuthType {
				t.Errorf("cfg.RegistryAuthType = %q, want %q", got, tc.wantAuthType)
			}
			if got := b.registryConfig.AuthType; got != tc.wantAuthType {
				t.Errorf("registryConfig.AuthType = %q, want %q", got, tc.wantAuthType)
			}
		})
	}
}
