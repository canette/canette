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
