// appNamespace returns the Kubernetes namespace for a project.
// Must stay in sync with AppNamespace() in apps/controller/internal/k8s/resources.go.
export function appNamespace(projectId: string, projectSlug: string): string {
  return `can-${projectId.slice(0, 8)}-${projectSlug.slice(0, 50)}`
}
