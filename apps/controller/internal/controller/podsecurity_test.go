package controller

import (
	"strings"
	"testing"
)

const restrictedWarning = `would violate PodSecurity "restricted:latest": runAsNonRoot != true (pod or container "website" must set securityContext.runAsNonRoot=true)`

func TestPodSecurityLogLines_WarnOnlyLevel(t *testing.T) {
	lines := podSecurityLogLines([]string{restrictedWarning}, "baseline", false)
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %q", len(lines), lines)
	}
	if !strings.HasPrefix(lines[0], "Pod Security notice (the app is not affected)") ||
		!strings.Contains(lines[0], `"restricted"`) || !strings.HasSuffix(lines[0], restrictedWarning) {
		t.Errorf("notice line = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "Tip: set security.hardened: true") || !strings.Contains(lines[1], podSecurityDocsURL) {
		t.Errorf("tip line = %q", lines[1])
	}
}

func TestPodSecurityLogLines_EnforcedLevel(t *testing.T) {
	lines := podSecurityLogLines([]string{restrictedWarning}, "restricted", false)
	want := []string{
		"Kubernetes warning: " + restrictedWarning,
		"The cluster enforces this level, so Kubernetes may refuse to start the app's pods.",
	}
	if len(lines) != 3 || lines[0] != want[0] || lines[1] != want[1] {
		t.Errorf("lines = %q, want %q followed by the tip", lines, want)
	}
}

func TestPodSecurityLogLines_HardenedHasNoTip(t *testing.T) {
	lines := podSecurityLogLines([]string{restrictedWarning}, "baseline", true)
	if len(lines) != 1 || strings.Contains(lines[0], "Tip:") {
		t.Errorf("lines = %q, want only the notice", lines)
	}
}

func TestPodSecurityLogLines_UnparsableLevel(t *testing.T) {
	// Without a level we can't tell whether it's enforced, so don't claim
	// the app is unaffected.
	w := "would violate PodSecurity: something unexpected"
	lines := podSecurityLogLines([]string{w}, "baseline", false)
	if lines[0] != "Kubernetes warning: "+w {
		t.Errorf("lines[0] = %q", lines[0])
	}
}
