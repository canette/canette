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
