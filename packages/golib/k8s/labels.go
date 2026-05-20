package k8s

// Label and annotation keys used on all canette-managed K8s resources.
const (
	LabelManagedBy    = "app.kubernetes.io/managed-by"
	LabelManagedByVal = "canette"

	LabelProject   = "canette.dev/project"
	LabelProjectID = "canette.dev/project-id"
	LabelApp       = "canette.dev/app"
	LabelComponent = "canette.dev/component"
	LabelDeployment = "canette.dev/deployment"

	AnnotDeploymentID = "canette.dev/deployment-id"
	LabelOwner        = "canette.dev/owner"
)

// AppLabelSelector returns a K8s label selector string matching the given app slug.
// Equivalent to labels.Set{LabelApp: appSlug}.String() for a single-label selector.
func AppLabelSelector(appSlug string) string {
	return LabelApp + "=" + appSlug
}
