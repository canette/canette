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

	LabelK8sName     = "app.kubernetes.io/name"
	LabelK8sInstance = "app.kubernetes.io/instance"
	LabelK8sPartOf   = "app.kubernetes.io/part-of"
	LabelK8sVersion  = "app.kubernetes.io/version"
)

// AppLabelSelector returns a K8s label selector string matching the given app slug.
// Equivalent to labels.Set{LabelApp: appSlug}.String() for a single-label selector.
func AppLabelSelector(appSlug string) string {
	return LabelApp + "=" + appSlug
}

// AppDeploymentLabelSelector returns a K8s label selector string matching only
// pods belonging to a specific deployment of an app — used to avoid matching a
// stale pod left over from a previous (possibly still-terminating) deployment
// of the same app.
func AppDeploymentLabelSelector(appSlug, deploymentID string) string {
	return LabelApp + "=" + appSlug + "," + LabelDeployment + "=" + deploymentID
}
