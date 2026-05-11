// Package scanner provides a provider abstraction for container image scanning.
// The active provider is selected by auto-detecting the registry type or via
// an explicit SCAN_PROVIDER env var override (mirrors the registry package).
package scanner

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"go.uber.org/zap"
	"k8s.io/client-go/kubernetes"
)

// Provider scans a built container image and returns the result.
type Provider interface {
	// HasScan returns true if Scan() will actually perform a scan.
	// When true, the caller should transition the deployment to 'scanning' status
	// before calling Scan(). False for NoneProvider.
	HasScan() bool
	Scan(ctx context.Context, deploymentID, imageRef string) (*ScanResult, error)
}

// ScanResult contains the outcome of a scan.
type ScanResult struct {
	Status  string // "pass" | "fail" | "error" | "skipped"
	Summary string // JSON: {"critical":0,...} — empty when skipped or error
	SBOM    string // CycloneDX JSON — empty for ECR provider and when skipped
	Blocked bool   // true when scan failed and mandatory is set
}

// LogAppender lets TrivyProvider write scan output lines to the build log store.
type LogAppender interface {
	AppendLog(ctx context.Context, deploymentID, stream, line string) error
}

// Config holds all scanner configuration, built from env vars in main.go.
type Config struct {
	// Provider: "auto" | "trivy" | "ecr" | "none"
	Provider string
	// EnabledStr: "" (provider-aware default) | "true" | "false"
	EnabledStr   string
	Mandatory    bool
	FailSeverity string // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"

	// Trivy-only
	TrivyImage    string
	SBOMEnabled   bool
	K8sClient     kubernetes.Interface
	Namespace     string
	NodeSelector  map[string]string
	Tolerations   []corev1.Toleration
	RegAuthSecret string
	LogAppender   LogAppender

	// Used by both auto-detect and ECR provider
	ImageRepo string

	// Logger for TrivyProvider internals
	Log *zap.Logger
}

// ScanName returns a stable identifier for MarkScanning — either a K8s job name
// (Trivy) or a pseudo-name (ECR) stored in build_job_name for observability.
func ScanName(deploymentID, providerName string) string {
	short := deploymentID
	if len(short) > 8 {
		short = short[:8]
	}
	if providerName == "ecr" {
		return "ecr-scan-" + short
	}
	return "can-scan-" + short
}

// NewProvider creates a Provider from cfg, applying auto-detection and
// provider-aware enabled defaults.
func NewProvider(cfg Config) (Provider, string, error) {
	name := cfg.Provider
	if name == "auto" || name == "" {
		name = detectProvider(cfg.ImageRepo)
	}

	enabled := resolveEnabled(cfg.EnabledStr, name)
	if !enabled || name == "none" {
		return &NoneProvider{}, name, nil
	}

	switch name {
	case "trivy":
		if cfg.K8sClient == nil {
			return nil, name, fmt.Errorf("trivy provider requires K8sClient")
		}
		return newTrivyProvider(cfg), name, nil
	case "ecr":
		p, err := newECRProvider(cfg)
		if err != nil {
			return nil, name, err
		}
		return p, name, nil
	default:
		return nil, name, fmt.Errorf("unknown scan provider: %s", name)
	}
}

func resolveEnabled(enabledStr, providerName string) bool {
	switch strings.ToLower(enabledStr) {
	case "true":
		return true
	case "false":
		return false
	default:
		// Provider-aware default: ECR is free, Trivy is slow/opt-in.
		return providerName == "ecr"
	}
}

func detectProvider(imageRepo string) string {
	if strings.Contains(imageRepo, ".ecr.") && strings.Contains(imageRepo, ".amazonaws.com") {
		return "ecr"
	}
	return "trivy"
}
