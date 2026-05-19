package k8s

import (
	"testing"
)

func TestAppNamespace(t *testing.T) {
	projectID := "17e4422a-1234-5678-abcd-ef0123456789"
	projectSlug := "my-project"

	expected := "can-17e4422a-my-project"
	got := AppNamespace(projectID, projectSlug)

	if got != expected {
		t.Errorf("AppNamespace() = %q, wanted format %q", got, expected)
	}
}

func baseDeployConfig() DeployConfig {
	return DeployConfig{
		ProjectID:        "proj-id-1234",
		ProjectSlug:      "my-project",
		AppSlug:          "my-app",
		ImageRef:         "registry/proj/app@sha256:abc123",
		Port:             3000,
		Replicas:         1,
		GatewayName:      "main-gateway",
		GatewayNamespace: "gateway-system",
		ClusterDomain:    "apps.example.com",
	}
}

func TestBuildResources_WebHasHTTPRoute(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.SkipHTTPRoute = false
	res := BuildResources(cfg)
	if res.HTTPRoute == nil {
		t.Error("expected HTTPRoute to be set for web deployment, got nil")
	}
}

func TestBuildResources_PrivateNoHTTPRoute(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.SkipHTTPRoute = true
	res := BuildResources(cfg)
	if res.HTTPRoute != nil {
		t.Error("expected HTTPRoute to be nil for private deployment, got non-nil")
	}
}

func TestAppNamespaceShortProjectID(t *testing.T) {
	got := AppNamespace("abc", "my-project")
	expected := "can-abc-my-project"
	if got != expected {
		t.Errorf("AppNamespace() = %q, wanted %q", got, expected)
	}
}

func TestAppNamespaceTruncatedProjectSlug(t *testing.T) {
	projectID := "17e4422a-1234-5678-abcd-ef0123456789"
	projectSlug := "my-project-has-a-really-long-name-that-would-break-kubernetes-namespace-limits"

	expected := "can-17e4422a-my-project-has-a-really-long-name-that-would-break"
	got := AppNamespace(projectID, projectSlug)

	if got != expected {
		t.Errorf("AppNamespace() = %q, wanted format %q", got, expected)
	}
}
