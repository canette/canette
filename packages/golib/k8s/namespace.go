// Package k8s provides shared Kubernetes naming and label conventions for canette.
package k8s

// AppNamespace returns the K8s namespace for a project: can-{id[:8]}-{slug[:50]}.
func AppNamespace(projectID, projectSlug string) string {
	if len(projectID) > 8 {
		projectID = projectID[:8]
	}
	if len(projectSlug) > 50 {
		projectSlug = projectSlug[:50]
	}
	return "can-" + projectID + "-" + projectSlug
}
