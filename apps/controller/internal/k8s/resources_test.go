package k8s

import (
	"testing"

	libk8s "canette.dev/lib/k8s"
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
		AuthgateImage:    "registry.example.com/canette-authgate:test",
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

func TestBuildResources_ExtraHostnames(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.SkipHTTPRoute = false
	cfg.ExtraHostnames = []string{"custom.example.com", "other.example.org"}
	res := BuildResources(cfg)
	if res.HTTPRoute == nil {
		t.Fatal("expected HTTPRoute to be set, got nil")
	}

	spec := res.HTTPRoute["spec"].(map[string]interface{})
	hostnames := spec["hostnames"].([]interface{})

	expected := []string{"my-app-my-project.apps.example.com", "custom.example.com", "other.example.org"}
	if len(hostnames) != len(expected) {
		t.Fatalf("expected %d hostnames, got %d: %v", len(expected), len(hostnames), hostnames)
	}
	for i, want := range expected {
		if hostnames[i] != want {
			t.Errorf("hostnames[%d] = %q, want %q", i, hostnames[i], want)
		}
	}
}

func TestBuildResources_ExtraHostnamesIgnoredWhenSkipHTTPRoute(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.SkipHTTPRoute = true
	cfg.ExtraHostnames = []string{"custom.example.com"}
	res := BuildResources(cfg)
	if res.HTTPRoute != nil {
		t.Error("expected HTTPRoute to be nil when SkipHTTPRoute is set, even with ExtraHostnames present")
	}
}

func TestBuildResources_PasswordGateAddsSidecarAndSecret(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.PasswordGate = PasswordGateConfig{Enabled: true, PasswordHash: "$2b$10$fakehash"}
	res := BuildResources(cfg)

	if res.AuthgateSecret == nil {
		t.Fatal("expected AuthgateSecret to be set, got nil")
	}
	meta, _ := res.AuthgateSecret["metadata"].(map[string]interface{})
	if got := meta["name"]; got != "my-app-authgate" {
		t.Errorf("AuthgateSecret name = %q, want %q", got, "my-app-authgate")
	}
	data, _ := res.AuthgateSecret["data"].(map[string]interface{})
	if got := string(data["PASSWORD_HASH"].([]byte)); got != "$2b$10$fakehash" {
		t.Errorf("AuthgateSecret PASSWORD_HASH = %q, want %q", got, "$2b$10$fakehash")
	}
	if _, ok := data["USERNAME"]; ok {
		t.Error("expected no USERNAME key in the authgate Secret — this gates one shared password, not accounts")
	}

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	if len(containers) != 2 {
		t.Fatalf("expected 2 containers, got %d", len(containers))
	}
	authgate, _ := containers[1].(map[string]interface{})
	if got := authgate["name"]; got != authgateContainerName {
		t.Errorf("second container name = %q, want %q", got, authgateContainerName)
	}
	if got := authgate["image"]; got != cfg.AuthgateImage {
		t.Errorf("authgate image = %q, want %q", got, cfg.AuthgateImage)
	}
	envFrom, _ := authgate["envFrom"].([]interface{})
	if len(envFrom) != 1 {
		t.Fatalf("expected 1 envFrom entry referencing the authgate secret, got %d", len(envFrom))
	}
	envFromEntry, _ := envFrom[0].(map[string]interface{})
	secretRef, _ := envFromEntry["secretRef"].(map[string]interface{})
	if got := secretRef["name"]; got != "my-app-authgate" {
		t.Errorf("envFrom secretRef name = %q, want %q", got, "my-app-authgate")
	}
	// Must match the AUTHGATE_ prefix authgate's main.go reads (AUTHGATE_PASSWORD_HASH) —
	// envFrom otherwise injects the Secret's bare key name (PASSWORD_HASH), which the
	// sidecar would never see and would crash-loop on startup.
	if got := envFromEntry["prefix"]; got != "AUTHGATE_" {
		t.Errorf("envFrom prefix = %q, want %q", got, "AUTHGATE_")
	}
	secCtx, ok := authgate["securityContext"].(map[string]interface{})
	if !ok {
		t.Fatal("expected authgate container to declare a securityContext")
	}
	if secCtx["runAsNonRoot"] != true {
		t.Error("expected runAsNonRoot: true")
	}
	// A FROM scratch image with no USER directive defaults to UID 0 — pairing
	// runAsNonRoot with no runAsUser makes the kubelet refuse to start the pod
	// ("container has runAsNonRoot and image will run as root").
	if _, ok := secCtx["runAsUser"]; !ok {
		t.Error("expected an explicit runAsUser alongside runAsNonRoot")
	}
	if _, ok := authgate["livenessProbe"]; !ok {
		t.Error("expected authgate container to declare a livenessProbe")
	}
	if _, ok := authgate["readinessProbe"]; !ok {
		t.Error("expected authgate container to declare a readinessProbe")
	}
}

func TestBuildResources_PasswordGateDisabledNoSidecar(t *testing.T) {
	cfg := baseDeployConfig() // PasswordGate zero-value (disabled)
	res := BuildResources(cfg)

	if res.AuthgateSecret != nil {
		t.Error("expected AuthgateSecret to be nil when gate is disabled, got non-nil")
	}
	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	if len(containers) != 1 {
		t.Fatalf("expected 1 container when gate is disabled, got %d", len(containers))
	}
}

func TestBuildResources_PasswordGateServiceTargetPort(t *testing.T) {
	enabled := baseDeployConfig()
	enabled.PasswordGate = PasswordGateConfig{Enabled: true, PasswordHash: "$2b$10$fakehash"}
	res := BuildResources(enabled)
	spec, _ := res.Service["spec"].(map[string]interface{})
	ports, _ := spec["ports"].([]interface{})
	port, _ := ports[0].(map[string]interface{})
	if got := port["targetPort"]; got != authgateSidecarPort {
		t.Errorf("targetPort = %v, want %v", got, authgateSidecarPort)
	}
	if got := port["port"]; got != 3000 {
		t.Errorf("port = %v, want %v", got, 3000)
	}

	disabled := baseDeployConfig()
	res = BuildResources(disabled)
	spec, _ = res.Service["spec"].(map[string]interface{})
	ports, _ = spec["ports"].([]interface{})
	port, _ = ports[0].(map[string]interface{})
	if got := port["targetPort"]; got != 3000 {
		t.Errorf("targetPort = %v, want %v", got, 3000)
	}
}

func TestBuildResources_PasswordGateUpstreamEnv(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.PasswordGate = PasswordGateConfig{Enabled: true, PasswordHash: "$2b$10$fakehash"}
	res := BuildResources(cfg)

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	authgate, _ := containers[1].(map[string]interface{})
	env, _ := authgate["env"].([]interface{})

	got := map[string]string{}
	for _, e := range env {
		entry, _ := e.(map[string]interface{})
		got[entry["name"].(string)] = entry["value"].(string)
	}
	if got["AUTHGATE_UPSTREAM_PORT"] != "3000" {
		t.Errorf("AUTHGATE_UPSTREAM_PORT = %q, want %q", got["AUTHGATE_UPSTREAM_PORT"], "3000")
	}
	if got["AUTHGATE_APP_SLUG"] != "my-app" {
		t.Errorf("AUTHGATE_APP_SLUG = %q, want %q", got["AUTHGATE_APP_SLUG"], "my-app")
	}
}

func TestBuildResources_PasswordGateIgnoredForCronJob(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "0 2 * * *"
	cfg.PasswordGate = PasswordGateConfig{Enabled: true, PasswordHash: "$2b$10$fakehash"}
	res := BuildResources(cfg)

	if res.AuthgateSecret != nil {
		t.Error("expected AuthgateSecret to be nil for a CronJob even with PasswordGate.Enabled set, got non-nil")
	}
	jobSpec, _ := res.CronJob["spec"].(map[string]interface{})
	jobTmpl, _ := jobSpec["jobTemplate"].(map[string]interface{})
	tmplSpec, _ := jobTmpl["spec"].(map[string]interface{})
	podTmpl, _ := tmplSpec["template"].(map[string]interface{})
	podSpec, _ := podTmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	if len(containers) != 1 {
		t.Fatalf("expected 1 container for CronJob, got %d", len(containers))
	}
}

func TestAppNamespaceShortProjectID(t *testing.T) {
	got := AppNamespace("abc", "my-project")
	expected := "can-abc-my-project"
	if got != expected {
		t.Errorf("AppNamespace() = %q, wanted %q", got, expected)
	}
}

func mainContainer(t *testing.T, res AppResources) map[string]interface{} {
	t.Helper()
	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	podSpec, _ := tmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	if len(containers) == 0 {
		t.Fatal("expected at least one container")
	}
	c, _ := containers[0].(map[string]interface{})
	return c
}

func TestBuildResources_ReadinessProbeWhenHealthcheckSet(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Healthcheck = &HealthcheckSpec{Path: "/healthz", Port: 3000, InitialDelaySeconds: 5, PeriodSeconds: 10}
	res := BuildResources(cfg)

	container := mainContainer(t, res)
	probe, ok := container["readinessProbe"].(map[string]interface{})
	if !ok {
		t.Fatal("expected readinessProbe to be set when Healthcheck is configured")
	}
	httpGet, _ := probe["httpGet"].(map[string]interface{})
	if httpGet["path"] != "/healthz" || httpGet["port"] != 3000 {
		t.Errorf("readinessProbe.httpGet = %v, want path=/healthz port=3000", httpGet)
	}
	if probe["initialDelaySeconds"] != 5 || probe["periodSeconds"] != 10 {
		t.Errorf("readinessProbe timing = %v, want initialDelaySeconds=5 periodSeconds=10", probe)
	}
	if _, hasLiveness := container["livenessProbe"]; hasLiveness {
		t.Error("expected no livenessProbe to be generated — readiness only, see resources.go")
	}
}

func TestBuildResources_NoReadinessProbeWhenHealthcheckAbsent(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Healthcheck = nil
	res := BuildResources(cfg)

	container := mainContainer(t, res)
	if _, ok := container["readinessProbe"]; ok {
		t.Error("expected no readinessProbe when canette.yaml has no healthcheck block — must not regress existing apps")
	}
}

func TestBuildResources_NoReadinessProbeForCronJob(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "0 2 * * *"
	cfg.Healthcheck = &HealthcheckSpec{Path: "/healthz", Port: 3000, InitialDelaySeconds: 5, PeriodSeconds: 10}
	res := BuildResources(cfg)

	jobSpec, _ := res.CronJob["spec"].(map[string]interface{})
	jobTmpl, _ := jobSpec["jobTemplate"].(map[string]interface{})
	tmplSpec, _ := jobTmpl["spec"].(map[string]interface{})
	podTmpl, _ := tmplSpec["template"].(map[string]interface{})
	podSpec, _ := podTmpl["spec"].(map[string]interface{})
	containers, _ := podSpec["containers"].([]interface{})
	container, _ := containers[0].(map[string]interface{})
	if _, ok := container["readinessProbe"]; ok {
		t.Error("expected no readinessProbe on a CronJob container even with Healthcheck configured — no Service routes to it")
	}
}

func TestBuildResources_PodTemplateHasDeploymentIDLabel(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.DeploymentID = "dep-abc-123"
	res := BuildResources(cfg)

	depSpec, _ := res.Deployment["spec"].(map[string]interface{})
	tmpl, _ := depSpec["template"].(map[string]interface{})
	tmplMeta, _ := tmpl["metadata"].(map[string]interface{})
	labels, _ := tmplMeta["labels"].(map[string]interface{})
	if labels[libk8s.LabelDeployment] != "dep-abc-123" {
		t.Errorf("pod template labels[%s] = %v, want %q — needed to scope rollout checks to this deployment", libk8s.LabelDeployment, labels[libk8s.LabelDeployment], "dep-abc-123")
	}

	// The selector must stay stable across redeploys of the same app — it must
	// NOT include the per-deploy DeploymentID label, since a Deployment's
	// spec.selector is immutable once created.
	selector, _ := depSpec["selector"].(map[string]interface{})
	matchLabels, _ := selector["matchLabels"].(map[string]interface{})
	if _, present := matchLabels[libk8s.LabelDeployment]; present {
		t.Error("expected spec.selector.matchLabels to NOT include the deployment-ID label (selector must remain stable across redeploys)")
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

func TestBuildResources_NetworkPolicyEnabled(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	if res.NetworkPolicy == nil {
		t.Fatal("expected NetworkPolicy to be set when NetworkPolicyEnabled, got nil")
	}
	meta, _ := res.NetworkPolicy["metadata"].(map[string]interface{})
	if got := meta["name"]; got != networkPolicyName {
		t.Errorf("NetworkPolicy name = %q, want %q", got, networkPolicyName)
	}
	if got := meta["namespace"]; got != AppNamespace(cfg.ProjectID, cfg.ProjectSlug) {
		t.Errorf("NetworkPolicy namespace = %q, want %q", got, AppNamespace(cfg.ProjectID, cfg.ProjectSlug))
	}
}

func TestBuildResources_NetworkPolicyDisabled(t *testing.T) {
	cfg := baseDeployConfig() // NetworkPolicyEnabled zero-value (false)
	res := BuildResources(cfg)

	if res.NetworkPolicy != nil {
		t.Error("expected NetworkPolicy to be nil when NetworkPolicyEnabled is false, got non-nil")
	}
}

func TestBuildResources_NetworkPolicyIngressFromGatewayNamespace(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	ingress, _ := spec["ingress"].([]interface{})
	if len(ingress) != 1 {
		t.Fatalf("expected 1 ingress rule, got %d", len(ingress))
	}
	rule, _ := ingress[0].(map[string]interface{})
	from, _ := rule["from"].([]interface{})
	if len(from) != 2 {
		t.Fatalf("expected 2 ingress 'from' peers, got %d", len(from))
	}
	peer, _ := from[0].(map[string]interface{})
	nsSelector, _ := peer["namespaceSelector"].(map[string]interface{})
	matchLabels, _ := nsSelector["matchLabels"].(map[string]interface{})
	if got := matchLabels["kubernetes.io/metadata.name"]; got != cfg.GatewayNamespace {
		t.Errorf("ingress namespaceSelector = %q, want %q (proves it's config-driven, not hardcoded)", got, cfg.GatewayNamespace)
	}
}

func TestBuildResources_NetworkPolicyIngressFromSameNamespace(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	ingress, _ := spec["ingress"].([]interface{})
	rule, _ := ingress[0].(map[string]interface{})
	from, _ := rule["from"].([]interface{})
	peer, _ := from[1].(map[string]interface{})
	podSelector, ok := peer["podSelector"].(map[string]interface{})
	if !ok {
		t.Fatal("expected second ingress peer to have a podSelector")
	}
	if len(podSelector) != 0 {
		t.Errorf("expected empty podSelector (matches all pods in own namespace), got %v", podSelector)
	}
	if _, hasNS := peer["namespaceSelector"]; hasNS {
		t.Error("same-namespace peer must not also set namespaceSelector, or it stops matching the local namespace")
	}
}

func TestBuildResources_NetworkPolicyEgressDNS(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	egress, _ := spec["egress"].([]interface{})
	if len(egress) != 3 {
		t.Fatalf("expected 3 egress rules, got %d", len(egress))
	}
	dnsRule, _ := egress[1].(map[string]interface{})
	to, _ := dnsRule["to"].([]interface{})
	peer, _ := to[0].(map[string]interface{})
	nsSelector, _ := peer["namespaceSelector"].(map[string]interface{})
	matchLabels, _ := nsSelector["matchLabels"].(map[string]interface{})
	if got := matchLabels["kubernetes.io/metadata.name"]; got != "kube-system" {
		t.Errorf("DNS egress namespaceSelector = %q, want %q", got, "kube-system")
	}
	ports, _ := dnsRule["ports"].([]interface{})
	if len(ports) != 2 {
		t.Fatalf("expected 2 DNS ports (UDP+TCP 53), got %d", len(ports))
	}
	seen := map[string]bool{}
	for _, p := range ports {
		port, _ := p.(map[string]interface{})
		seen[port["protocol"].(string)] = port["port"] == int64(53)
	}
	if !seen["UDP"] || !seen["TCP"] {
		t.Errorf("expected UDP and TCP port 53 in DNS egress rule, got %v", ports)
	}
}

func TestBuildResources_NetworkPolicyEgressSameNamespace(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	egress, _ := spec["egress"].([]interface{})
	rule, _ := egress[0].(map[string]interface{})
	to, _ := rule["to"].([]interface{})
	if len(to) != 1 {
		t.Fatalf("expected 1 'to' peer in same-namespace egress rule, got %d", len(to))
	}
	peer, _ := to[0].(map[string]interface{})
	podSelector, ok := peer["podSelector"].(map[string]interface{})
	if !ok {
		t.Fatal("expected same-namespace egress peer to have a podSelector")
	}
	if len(podSelector) != 0 {
		t.Errorf("expected empty podSelector (matches all pods in own namespace), got %v", podSelector)
	}
	if _, hasPorts := rule["ports"]; hasPorts {
		t.Error("same-namespace egress rule should not restrict ports (a database may listen on any port)")
	}
}

func TestBuildResources_NetworkPolicyEgressInternetExcludesReservedRanges(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	egress, _ := spec["egress"].([]interface{})
	internetRule, _ := egress[2].(map[string]interface{})
	to, _ := internetRule["to"].([]interface{})
	peer, _ := to[0].(map[string]interface{})
	ipBlock, _ := peer["ipBlock"].(map[string]interface{})
	if got := ipBlock["cidr"]; got != "0.0.0.0/0" {
		t.Errorf("internet egress cidr = %q, want %q", got, "0.0.0.0/0")
	}
	except, _ := ipBlock["except"].([]interface{})
	want := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"100.64.0.0/10",
		"169.254.0.0/16",
		"127.0.0.0/8",
	}
	if len(except) != len(want) {
		t.Fatalf("expected %d excepted CIDRs, got %d: %v", len(want), len(except), except)
	}
	for i, w := range want {
		if except[i] != w {
			t.Errorf("except[%d] = %q, want %q", i, except[i], w)
		}
	}
}

func TestBuildResources_NetworkPolicyTypes(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	policyTypes, _ := spec["policyTypes"].([]interface{})
	if len(policyTypes) != 2 || policyTypes[0] != "Ingress" || policyTypes[1] != "Egress" {
		t.Errorf("policyTypes = %v, want [Ingress Egress]", policyTypes)
	}
}

func TestBuildResources_NetworkPolicyPodSelectorEmpty(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.NetworkPolicyEnabled = true
	res := BuildResources(cfg)

	spec, _ := res.NetworkPolicy["spec"].(map[string]interface{})
	podSelector, ok := spec["podSelector"].(map[string]interface{})
	if !ok {
		t.Fatal("expected podSelector to be a map")
	}
	if len(podSelector) != 0 {
		t.Errorf("expected empty podSelector (applies to every pod in the namespace), got %v", podSelector)
	}
}

// ── Secure-by-default workload settings (issue #250) ─────────────────────────

func testWorkloadDefaults() WorkloadDefaults {
	return WorkloadDefaults{
		TerminationGracePeriodSeconds:  30,
		RevisionHistoryLimit:           3,
		CronJobStartingDeadlineSeconds: 300,
		CronJobBackoffLimit:            2,
		CronJobActiveDeadlineSeconds:   21600,
		CronJobTTLSecondsAfterFinished: 86400,
	}
}

func deploymentSpec(t *testing.T, res AppResources) map[string]interface{} {
	t.Helper()
	spec, ok := res.Deployment["spec"].(map[string]interface{})
	if !ok {
		t.Fatal("Deployment spec missing")
	}
	return spec
}

func deploymentPodSpec(t *testing.T, res AppResources) map[string]interface{} {
	t.Helper()
	tmpl, _ := deploymentSpec(t, res)["template"].(map[string]interface{})
	podSpec, ok := tmpl["spec"].(map[string]interface{})
	if !ok {
		t.Fatal("Deployment pod spec missing")
	}
	return podSpec
}

func cronJobSpecs(t *testing.T, res AppResources) (cronSpec, jobSpec, podSpec map[string]interface{}) {
	t.Helper()
	cronSpec, _ = res.CronJob["spec"].(map[string]interface{})
	jobTmpl, _ := cronSpec["jobTemplate"].(map[string]interface{})
	jobSpec, _ = jobTmpl["spec"].(map[string]interface{})
	tmpl, _ := jobSpec["template"].(map[string]interface{})
	podSpec, _ = tmpl["spec"].(map[string]interface{})
	if podSpec == nil {
		t.Fatal("CronJob pod spec missing")
	}
	return cronSpec, jobSpec, podSpec
}

func assertSecurePodDefaults(t *testing.T, podSpec map[string]interface{}) {
	t.Helper()
	if got := podSpec["automountServiceAccountToken"]; got != false {
		t.Errorf("automountServiceAccountToken = %v, want false", got)
	}
	if got := podSpec["enableServiceLinks"]; got != false {
		t.Errorf("enableServiceLinks = %v, want false", got)
	}
	sc, _ := podSpec["securityContext"].(map[string]interface{})
	seccomp, _ := sc["seccompProfile"].(map[string]interface{})
	if got := seccomp["type"]; got != "RuntimeDefault" {
		t.Errorf("seccompProfile.type = %v, want RuntimeDefault", got)
	}
	containers, _ := podSpec["containers"].([]interface{})
	app, _ := containers[0].(map[string]interface{})
	csc, _ := app["securityContext"].(map[string]interface{})
	if got := csc["allowPrivilegeEscalation"]; got != false {
		t.Errorf("app container allowPrivilegeEscalation = %v, want false", got)
	}
}

func TestBuildResources_SecurePodDefaultsDeployment(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Workload = testWorkloadDefaults()
	podSpec := deploymentPodSpec(t, BuildResources(cfg))
	assertSecurePodDefaults(t, podSpec)
	if got := podSpec["terminationGracePeriodSeconds"]; got != 30 {
		t.Errorf("terminationGracePeriodSeconds = %v, want 30", got)
	}
}

func TestBuildResources_SecurePodDefaultsCronJob(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "@daily"
	cfg.Workload = testWorkloadDefaults()
	_, _, podSpec := cronJobSpecs(t, BuildResources(cfg))
	assertSecurePodDefaults(t, podSpec)
}

func TestBuildResources_ZeroWorkloadDefaultsOmitted(t *testing.T) {
	cfg := baseDeployConfig() // Workload left zero
	res := BuildResources(cfg)
	if _, ok := deploymentPodSpec(t, res)["terminationGracePeriodSeconds"]; ok {
		t.Error("terminationGracePeriodSeconds should be omitted when 0")
	}
	if _, ok := deploymentSpec(t, res)["revisionHistoryLimit"]; ok {
		t.Error("revisionHistoryLimit should be omitted when 0")
	}

	cfg.IsCronJob = true
	cfg.Schedule = "@daily"
	cronSpec, jobSpec, _ := cronJobSpecs(t, BuildResources(cfg))
	if _, ok := cronSpec["startingDeadlineSeconds"]; ok {
		t.Error("startingDeadlineSeconds should be omitted when 0")
	}
	for _, k := range []string{"backoffLimit", "activeDeadlineSeconds", "ttlSecondsAfterFinished"} {
		if _, ok := jobSpec[k]; ok {
			t.Errorf("jobTemplate.spec.%s should be omitted when 0", k)
		}
	}
}

func TestBuildResources_RevisionHistoryLimit(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Workload = testWorkloadDefaults()
	if got := deploymentSpec(t, BuildResources(cfg))["revisionHistoryLimit"]; got != 3 {
		t.Errorf("revisionHistoryLimit = %v, want 3", got)
	}
}

func TestBuildResources_RollingUpdateWithoutPVC(t *testing.T) {
	cfg := baseDeployConfig()
	// emptyDir and configmap volumes don't need Recreate.
	cfg.Volumes = []VolumeSpec{
		{Name: "tmp", Type: "emptyDir", MountPath: "/tmp/x"},
		{Name: "cfg", Type: "configmap", MountPath: "/etc/app/config.yaml", Content: "a: 1"},
	}
	strategy, _ := deploymentSpec(t, BuildResources(cfg))["strategy"].(map[string]interface{})
	if got := strategy["type"]; got != "RollingUpdate" {
		t.Fatalf("strategy.type = %v, want RollingUpdate", got)
	}
	ru, _ := strategy["rollingUpdate"].(map[string]interface{})
	if ru["maxUnavailable"] != 0 || ru["maxSurge"] != 1 {
		t.Errorf("rollingUpdate = %v, want maxUnavailable 0 / maxSurge 1", ru)
	}
}

func TestBuildResources_RecreateWithPVC(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Volumes = []VolumeSpec{{Name: "data", Type: "pvc", MountPath: "/data", Size: "1Gi"}}
	strategy, _ := deploymentSpec(t, BuildResources(cfg))["strategy"].(map[string]interface{})
	if got := strategy["type"]; got != "Recreate" {
		t.Errorf("strategy.type = %v, want Recreate", got)
	}
	if _, ok := strategy["rollingUpdate"]; ok {
		t.Error("rollingUpdate must not be set with Recreate")
	}
}

func TestBuildResources_SingleReplicaNoSpreadNoPDB(t *testing.T) {
	cfg := baseDeployConfig() // Replicas: 1
	res := BuildResources(cfg)
	if res.PodDisruptionBudget != nil {
		t.Error("expected no PDB for a single replica")
	}
	if _, ok := deploymentPodSpec(t, res)["topologySpreadConstraints"]; ok {
		t.Error("expected no topologySpreadConstraints for a single replica")
	}
}

func TestBuildResources_MultiReplicaSpreadAndPDB(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.Replicas = 3
	res := BuildResources(cfg)

	tsc, _ := deploymentPodSpec(t, res)["topologySpreadConstraints"].([]interface{})
	if len(tsc) != 2 {
		t.Fatalf("expected 2 topologySpreadConstraints, got %d", len(tsc))
	}
	keys := map[string]bool{}
	for _, c := range tsc {
		m, _ := c.(map[string]interface{})
		keys[m["topologyKey"].(string)] = true
		if m["whenUnsatisfiable"] != "ScheduleAnyway" {
			t.Errorf("whenUnsatisfiable = %v, want ScheduleAnyway", m["whenUnsatisfiable"])
		}
		sel, _ := m["labelSelector"].(map[string]interface{})
		ml, _ := sel["matchLabels"].(map[string]interface{})
		if _, ok := ml[libk8s.LabelK8sVersion]; ok {
			t.Error("spread labelSelector must not contain the per-deploy version label")
		}
	}
	if !keys["topology.kubernetes.io/zone"] || !keys["kubernetes.io/hostname"] {
		t.Errorf("topology keys = %v, want zone and hostname", keys)
	}

	pdb := res.PodDisruptionBudget
	if pdb == nil {
		t.Fatal("expected a PDB for replicas > 1")
	}
	if pdb["apiVersion"] != "policy/v1" || pdb["kind"] != "PodDisruptionBudget" {
		t.Errorf("unexpected PDB type %v/%v", pdb["apiVersion"], pdb["kind"])
	}
	meta, _ := pdb["metadata"].(map[string]interface{})
	if meta["name"] != "my-app" || meta["namespace"] != AppNamespace(cfg.ProjectID, cfg.ProjectSlug) {
		t.Errorf("PDB name/namespace = %v/%v", meta["name"], meta["namespace"])
	}
	spec, _ := pdb["spec"].(map[string]interface{})
	if spec["maxUnavailable"] != 1 {
		t.Errorf("PDB maxUnavailable = %v, want 1", spec["maxUnavailable"])
	}
	sel, _ := spec["selector"].(map[string]interface{})
	ml, _ := sel["matchLabels"].(map[string]interface{})
	if ml[libk8s.LabelApp] != "my-app" {
		t.Errorf("PDB selector app label = %v, want my-app", ml[libk8s.LabelApp])
	}
	if _, ok := ml[libk8s.LabelDeployment]; ok {
		t.Error("PDB selector must not contain the per-deploy deployment label")
	}
}

func TestBuildResources_CronJobNoPDB(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "@daily"
	cfg.Replicas = 3
	if BuildResources(cfg).PodDisruptionBudget != nil {
		t.Error("CronJobs must never get a PDB")
	}
}

func TestBuildResources_CronJobDeadlines(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.IsCronJob = true
	cfg.Schedule = "@daily"
	cfg.Workload = testWorkloadDefaults()
	cronSpec, jobSpec, _ := cronJobSpecs(t, BuildResources(cfg))
	if got := cronSpec["startingDeadlineSeconds"]; got != 300 {
		t.Errorf("startingDeadlineSeconds = %v, want 300", got)
	}
	want := map[string]int{"backoffLimit": 2, "activeDeadlineSeconds": 21600, "ttlSecondsAfterFinished": 86400}
	for k, v := range want {
		if got := jobSpec[k]; got != v {
			t.Errorf("jobTemplate.spec.%s = %v, want %d", k, got, v)
		}
	}
}

func TestBuildResources_AuthgateSidecarHasResources(t *testing.T) {
	cfg := baseDeployConfig()
	cfg.PasswordGate = PasswordGateConfig{Enabled: true, PasswordHash: "$2b$10$abc"}
	containers, _ := deploymentPodSpec(t, BuildResources(cfg))["containers"].([]interface{})
	if len(containers) != 2 {
		t.Fatalf("expected 2 containers, got %d", len(containers))
	}
	gate, _ := containers[1].(map[string]interface{})
	res, _ := gate["resources"].(map[string]interface{})
	for _, k := range []string{"requests", "limits"} {
		m, _ := res[k].(map[string]interface{})
		if m["cpu"] == nil || m["memory"] == nil {
			t.Errorf("authgate resources.%s = %v, want cpu and memory set", k, m)
		}
	}
}
