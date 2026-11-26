package controller

import (
	"fmt"
	"regexp"
)

// podSecurityDocsURL explains the Pod Security warning and the hardened-mode fix.
const podSecurityDocsURL = "https://canette.dev/docs/troubleshooting/deploy-issues#deploy-log-shows-would-violate-podsecurity"

// podSecurityLevelRe extracts the level from a Pod Security Admission warning,
// e.g. `would violate PodSecurity "restricted:latest": ...` → restricted.
var podSecurityLevelRe = regexp.MustCompile(`would violate PodSecurity "([a-z]+)(?::[^"]*)?"`)

// podSecurityLogLines turns the Pod Security Admission warnings from one apply
// into deploy-log lines. A warning for a level stricter than the enforced one
// (the default: warn=restricted, enforce=baseline) doesn't stop the app, and
// the log says so, so users don't mistake it for the cause of a failure.
func podSecurityLogLines(warnings []string, enforce string, hardened bool) []string {
	var lines []string
	enforced := false
	for _, w := range warnings {
		level := ""
		if m := podSecurityLevelRe.FindStringSubmatch(w); m != nil {
			level = m[1]
		}
		if level != "" && level != enforce {
			lines = append(lines, fmt.Sprintf(
				"Pod Security notice (the app is not affected): the app doesn't meet the stricter %q level, "+
					"which this cluster only checks and doesn't enforce. Kubernetes reported: %s", level, w))
		} else {
			enforced = true
			lines = append(lines, "Kubernetes warning: "+w)
		}
	}
	if enforced {
		lines = append(lines, "The cluster enforces this level, so Kubernetes may refuse to start the app's pods.")
	}
	if !hardened {
		lines = append(lines, "Tip: set security.hardened: true in canette.yaml to meet this level. "+
			"Why this shows up and how to fix it: "+podSecurityDocsURL)
	}
	return lines
}
