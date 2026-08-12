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

func TestBuildResources_CronJobNoDeploymentOrService(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "0 2 * * *"
	res := BuildResources(cfg)
	if res.CronJob == nil {
		t.Error("expected CronJob to be set for cronjob deployment, got nil")
	}
	if res.Deployment != nil {
		t.Error("expected Deployment to be nil for cronjob deployment, got non-nil")
	}
	if res.Service != nil {
		t.Error("expected Service to be nil for cronjob deployment, got nil")
	}
	if res.HTTPRoute != nil {
		t.Error("expected HTTPRoute to be nil for cronjob deployment, got non-nil")
	}
}

func TestBuildResources_CronJobSchedule(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "@daily"
	res := BuildResources(cfg)
	spec, ok := res.CronJob["spec"].(map[string]interface{})
	if !ok {
		t.Fatal("CronJob spec is not a map")
	}
	if got := spec["schedule"]; got != "@daily" {
		t.Errorf("CronJob schedule = %q, want %q", got, "@daily")
	}
	if got := spec["concurrencyPolicy"]; got != "Forbid" {
		t.Errorf("CronJob concurrencyPolicy = %q, want %q", got, "Forbid")
	}
}

func TestBuildResources_PVCVolume(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Volumes = []VolumeSpec{
		{Name: "data", Type: "pvc", MountPath: "/data", Size: "5Gi"},
	}
	res := BuildResources(cfg)

	if len(res.PVCs) != 1 {
		t.Fatalf("expected 1 PVC, got %d", len(res.PVCs))
	}

	pvc := res.PVCs[0]
	meta, _ := pvc["metadata"].(map[string]interface{})
	if got := meta["name"]; got != "my-app-data" {
		t.Errorf("PVC name = %q, want %q", got, "my-app-data")
	}
	spec, _ := pvc["spec"].(map[string]interface{})
	reqs, _ := spec["resources"].(map[string]interface{})
	requests, _ := reqs["requests"].(map[string]interface{})
	if got := requests["storage"]; got != "5Gi" {
		t.Errorf("PVC storage = %q, want %q", got, "5Gi")
	}
	// storageClassName must NOT be set (use cluster default)
	if _, ok := spec["storageClassName"]; ok {
		t.Error("expected storageClassName to be absent; got it set")
	}

	// Verify volumeMount in container
	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	container, _ := containers[0].(map[string]interface{})
	mounts, _ := container["volumeMounts"].([]interface{})
	if len(mounts) != 1 {
		t.Fatalf("expected 1 volumeMount, got %d", len(mounts))
	}
	mount, _ := mounts[0].(map[string]interface{})
	if got := mount["mountPath"]; got != "/data" {
		t.Errorf("volumeMount mountPath = %q, want %q", got, "/data")
	}
}

func TestBuildResources_EmptyDirVolume(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Volumes = []VolumeSpec{
		{Name: "cache", Type: "emptyDir", MountPath: "/tmp/cache", Size: "200Mi"},
	}
	res := BuildResources(cfg)

	if len(res.PVCs) != 0 {
		t.Errorf("expected no PVCs for emptyDir, got %d", len(res.PVCs))
	}

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	vols, _ := podSpec["volumes"].([]interface{})
	if len(vols) != 1 {
		t.Fatalf("expected 1 volume, got %d", len(vols))
	}
	vol, _ := vols[0].(map[string]interface{})
	emptyDir, _ := vol["emptyDir"].(map[string]interface{})
	if got := emptyDir["sizeLimit"]; got != "200Mi" {
		t.Errorf("emptyDir sizeLimit = %q, want %q", got, "200Mi")
	}
}

func TestBuildResources_ConfigMapVolume(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Volumes = []VolumeSpec{
		{Name: "nginx-conf", Type: "configmap", MountPath: "/etc/nginx/nginx.conf", Content: "worker_processes 1;"},
	}
	res := BuildResources(cfg)

	if len(res.ConfigMaps) != 1 {
		t.Fatalf("expected 1 ConfigMap, got %d", len(res.ConfigMaps))
	}

	cm := res.ConfigMaps[0]
	meta, _ := cm["metadata"].(map[string]interface{})
	if got := meta["name"]; got != "my-app-nginx-conf-cfg" {
		t.Errorf("ConfigMap name = %q, want %q", got, "my-app-nginx-conf-cfg")
	}

	// Verify subPath in volumeMount
	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	container, _ := containers[0].(map[string]interface{})
	mounts, _ := container["volumeMounts"].([]interface{})
	if len(mounts) != 1 {
		t.Fatalf("expected 1 volumeMount, got %d", len(mounts))
	}
	mount, _ := mounts[0].(map[string]interface{})
	if got := mount["mountPath"]; got != "/etc/nginx/nginx.conf" {
		t.Errorf("volumeMount mountPath = %q, want %q", got, "/etc/nginx/nginx.conf")
	}
	if got := mount["subPath"]; got != "nginx.conf" {
		t.Errorf("volumeMount subPath = %q, want %q", got, "nginx.conf")
	}
}

func TestBuildResources_VersionLabelExcludedFromSelectors(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.CommitSha = "abcdef1234567890"
	res := BuildResources(cfg)

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	selector, _ := depSpec["selector"].(map[string]interface{})
	matchLabels, _ := selector["matchLabels"].(map[string]interface{})
	if _, ok := matchLabels["app.kubernetes.io/version"]; ok {
		t.Error("expected Deployment selector.matchLabels to omit app.kubernetes.io/version, got it set")
	}

	svcSpec, _ := res.Service["spec"].(map[string]interface{})
	svcSelector, _ := svcSpec["selector"].(map[string]interface{})
	if _, ok := svcSelector["app.kubernetes.io/version"]; ok {
		t.Error("expected Service spec.selector to omit app.kubernetes.io/version, got it set")
	}
}

func TestBuildResources_VersionLabelOnPodTemplate(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.CommitSha = "abcdef1234567890"
	res := BuildResources(cfg)

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	tmplMeta, _ := tmpl["metadata"].(map[string]interface{})
	tmplLabels, _ := tmplMeta["labels"].(map[string]interface{})
	if got := tmplLabels["app.kubernetes.io/version"]; got != "abcdef1" {
		t.Errorf("pod template app.kubernetes.io/version = %q, want %q", got, "abcdef1")
	}
}

func TestBuildResources_VersionLabelOmittedWithoutCommitSha(t *testing.T) {
	cfg := baseDeployConfig()
	res := BuildResources(cfg)

	depMeta, _ := res.Deployment["metadata"].(map[string]interface{})
	depLabels, _ := depMeta["labels"].(map[string]interface{})
	if _, ok := depLabels["app.kubernetes.io/version"]; ok {
		t.Error("expected app.kubernetes.io/version to be absent when CommitSha is empty, got it set")
	}
}

func TestBuildResources_DeploymentIDAnnotation(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.DeploymentID = "dep-123"
	res := BuildResources(cfg)

	depMeta, _ := res.Deployment["metadata"].(map[string]interface{})
	depAnnotations, _ := depMeta["annotations"].(map[string]interface{})
	if got := depAnnotations["canette.dev/deployment-id"]; got != "dep-123" {
		t.Errorf("Deployment annotation canette.dev/deployment-id = %q, want %q", got, "dep-123")
	}

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	tmplMeta, _ := tmpl["metadata"].(map[string]interface{})
	tmplAnnotations, _ := tmplMeta["annotations"].(map[string]interface{})
	if got := tmplAnnotations["canette.dev/deployment-id"]; got != "dep-123" {
		t.Errorf("pod template annotation canette.dev/deployment-id = %q, want %q", got, "dep-123")
	}
}

func TestBuildResources_NoAnnotationsWithoutDeploymentID(t *testing.T) {
	cfg := baseDeployConfig()
	res := BuildResources(cfg)

	depMeta, _ := res.Deployment["metadata"].(map[string]interface{})
	if _, ok := depMeta["annotations"]; ok {
		t.Error("expected Deployment metadata.annotations to be absent when DeploymentID is empty, got it set")
	}
}

func TestBuildResources_NoVolumes(t *testing.T) {
	cfg := baseDeployConfig()
	res := BuildResources(cfg)

	if len(res.PVCs) != 0 {
		t.Errorf("expected no PVCs, got %d", len(res.PVCs))
	}
	if len(res.ConfigMaps) != 0 {
		t.Errorf("expected no ConfigMaps, got %d", len(res.ConfigMaps))
	}
	// volumes and volumeMounts should be absent from pod spec
	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	if _, ok := podSpec["volumes"]; ok {
		t.Error("expected no volumes key in podSpec, got one")
	}
	containers, _ := podSpec["containers"].([]interface{})
	container, _ := containers[0].(map[string]interface{})
	if _, ok := container["volumeMounts"]; ok {
		t.Error("expected no volumeMounts in container, got one")
	}
}

