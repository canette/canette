package k8s

// Volume types as stored in app_volumes.type.
const (
	VolumeTypePVC       = "pvc"
	VolumeTypeEmptyDir  = "emptyDir"
	VolumeTypeConfigMap = "configmap"
)

// PVCName returns the PersistentVolumeClaim name backing a "pvc" volume:
// {appSlug}-{volumeName}.
func PVCName(appSlug, volumeName string) string {
	return appSlug + "-" + volumeName
}

// VolumeConfigMapName returns the ConfigMap name backing a "configmap" volume:
// {appSlug}-{volumeName}-cfg.
func VolumeConfigMapName(appSlug, volumeName string) string {
	return appSlug + "-" + volumeName + "-cfg"
}

// VolumeResource returns the K8s kind and name of the standalone resource
// backing a volume of the given type. ok is false for types that have no
// resource of their own (emptyDir) and for unknown types.
func VolumeResource(appSlug, volumeName, volumeType string) (kind, name string, ok bool) {
	switch volumeType {
	case VolumeTypePVC:
		return "PersistentVolumeClaim", PVCName(appSlug, volumeName), true
	case VolumeTypeConfigMap:
		return "ConfigMap", VolumeConfigMapName(appSlug, volumeName), true
	}
	return "", "", false
}
