package k8s

import (
	"encoding/base64"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func TestJobName(t *testing.T) {
	id := "d59d1c36-e793-4439-8919-04d97ed2eb04"
	got := JobName(id)

	if !strings.HasPrefix(got, "can-build-") {
		t.Errorf("JobName() = %q, want prefix %q", got, "can-build-")
	}
	// Suffix must be the first 8 chars of the deployment ID
	wantSuffix := id[:8]
	if !strings.HasSuffix(got, wantSuffix) {
		t.Errorf("JobName() = %q, want suffix %q", got, wantSuffix)
	}
}

// findEnv returns the value of the named env var in container, or fails the test.
func findEnv(t *testing.T, c corev1.Container, name string) string {
	t.Helper()
	for _, e := range c.Env {
		if e.Name == name {
			return e.Value
		}
	}
	t.Fatalf("env var %q not found in container %q", name, c.Name)
	return ""
}

// hasMountAt returns true if container has a VolumeMount with the given name and mountPath.
func hasMountAt(c corev1.Container, volumeName, mountPath string) bool {
	for _, m := range c.VolumeMounts {
		if m.Name == volumeName && m.MountPath == mountPath {
			return true
		}
	}
	return false
}

// hasVolume returns true if the pod spec contains a volume with the given name.
func hasVolume(spec corev1.PodSpec, name string) bool {
	for _, v := range spec.Volumes {
		if v.Name == name {
			return true
		}
	}
	return false
}

var baseCfg = BuildConfig{
	Namespace:     "canette-build",
	ImageRepo:     "registry.example.com/",
	BuildkitdAddr: "tcp://buildkitd.canette-build.svc.cluster.local:1234",
	BuilderImage:  "registry.example.com/canette-builder:latest",
	GitInitImage:  "registry.example.com/canette-builder-git-init:latest",
}

const (
	testDeploymentID = "d59d1c36-e793-4439-8919-04d97ed2eb04"
	testProjectSlug  = "myproject"
	testAppSlug      = "myapp"
	testCommitSha    = "abc1234def5678"
	testGitURL       = "https://github.com/example/repo.git"
	testGitBranch    = "main"
	testAppPath      = "."
	testCanetteCfg   = "runtime:\n  port: 3000\n"
)

func TestBuildJob(t *testing.T) {
	tests := []struct {
		name           string
		credType       string
		credSecretName string
		cfg            BuildConfig
		checkFn        func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container)
	}{
		{
			name:           "no credentials no registry auth",
			credType:       "none",
			credSecretName: "",
			cfg:            baseCfg,
			checkFn: func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container) {
				// git-credentials volume must exist but be optional (placeholder)
				var gitCredVol *corev1.Volume
				for i := range spec.Volumes {
					if spec.Volumes[i].Name == "git-credentials" {
						gitCredVol = &spec.Volumes[i]
					}
				}
				if gitCredVol == nil {
					t.Fatal("git-credentials volume missing")
				}
				if gitCredVol.Secret == nil {
					t.Fatal("git-credentials volume must be a Secret volume")
				}
				if gitCredVol.Secret.Optional == nil || !*gitCredVol.Secret.Optional {
					t.Error("git-credentials volume must be optional=true when no creds provided")
				}
				if gitCredVol.Secret.SecretName != "can-gitcred-placeholder" {
					t.Errorf("placeholder secret name = %q, want %q", gitCredVol.Secret.SecretName, "can-gitcred-placeholder")
				}
				// No registry-auth volume
				if hasVolume(spec, "registry-auth") {
					t.Error("registry-auth volume must not be present without RegistryAuthSecret")
				}
				// Railpack: only workspace mount
				for _, m := range imageBuild.VolumeMounts {
					if m.Name == "registry-auth" {
						t.Error("image-build must not have registry-auth mount without RegistryAuthSecret")
					}
				}
			},
		},
		{
			name:           "with PAT credentials",
			credType:       "pat",
			credSecretName: "can-gitcred-d59d1c36",
			cfg:            baseCfg,
			checkFn: func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container) {
				var gitCredVol *corev1.Volume
				for i := range spec.Volumes {
					if spec.Volumes[i].Name == "git-credentials" {
						gitCredVol = &spec.Volumes[i]
					}
				}
				if gitCredVol == nil {
					t.Fatal("git-credentials volume missing")
				}
				if gitCredVol.Secret.SecretName != "can-gitcred-d59d1c36" {
					t.Errorf("git-credentials secret name = %q, want %q", gitCredVol.Secret.SecretName, "can-gitcred-d59d1c36")
				}
				if findEnv(t, gitClone, "GIT_CREDENTIAL_TYPE") != "pat" {
					t.Error("GIT_CREDENTIAL_TYPE must be 'pat'")
				}
			},
		},
		{
			name:           "with SSH credentials",
			credType:       "ssh_key",
			credSecretName: "can-gitcred-d59d1c36",
			cfg:            baseCfg,
			checkFn: func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container) {
				if findEnv(t, gitClone, "GIT_CREDENTIAL_TYPE") != "ssh_key" {
					t.Error("GIT_CREDENTIAL_TYPE must be 'ssh_key'")
				}
			},
		},
		{
			name:     "with registry auth secret (static)",
			credType: "none",
			cfg: BuildConfig{
				Namespace:          baseCfg.Namespace,
				ImageRepo:          baseCfg.ImageRepo,
				BuildkitdAddr:      baseCfg.BuildkitdAddr,
				BuilderImage:       baseCfg.BuilderImage,
				GitInitImage:       baseCfg.GitInitImage,
				RegistryAuthSecret: "my-reg-secret",
				RegistryAuthType:   "static",
			},
			checkFn: func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container) {
				if !hasVolume(spec, "registry-auth") {
					t.Fatal("registry-auth volume must be present when RegistryAuthSecret is set")
				}
				var regVol *corev1.Volume
				for i := range spec.Volumes {
					if spec.Volumes[i].Name == "registry-auth" {
						regVol = &spec.Volumes[i]
					}
				}
				if regVol.Secret.SecretName != "my-reg-secret" {
					t.Errorf("registry-auth secret name = %q, want %q", regVol.Secret.SecretName, "my-reg-secret")
				}
				if len(regVol.Secret.Items) != 1 || regVol.Secret.Items[0].Key != ".dockerconfigjson" || regVol.Secret.Items[0].Path != "config.json" {
					t.Error("registry-auth volume must map .dockerconfigjson → config.json")
				}
				if !hasMountAt(imageBuild, "registry-auth", "/home/canette/.docker") {
					t.Error("image-build must mount registry-auth at /home/canette/.docker")
				}
				if findEnv(t, imageBuild, "DOCKER_CONFIG") != "/home/canette/.docker" {
					t.Error("DOCKER_CONFIG must point at the mount so buildctl forwards credentials to buildkitd")
				}
				// All build job pods run without a service account — registry auth is
				// handled by mounting a docker config Secret, not via pod identity.
				if spec.ServiceAccountName != "" {
					t.Errorf("ServiceAccountName = %q, want empty", spec.ServiceAccountName)
				}
				if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
					t.Error("AutomountServiceAccountToken must be false")
				}
			},
		},
		{
			// IRSA: the builder daemon generates a short-lived ECR token and writes it
			// to a per-build Secret referenced via RegistryAuthSecret, just like static
			// auth. No service account is needed on the build job pod itself.
			name:     "with IRSA auth (dynamic registry-auth secret)",
			credType: "none",
			cfg: BuildConfig{
				Namespace:          baseCfg.Namespace,
				ImageRepo:          baseCfg.ImageRepo,
				BuildkitdAddr:      baseCfg.BuildkitdAddr,
				BuilderImage:       baseCfg.BuilderImage,
				GitInitImage:       baseCfg.GitInitImage,
				RegistryAuthType:   "irsa",
				RegistryAuthSecret: "can-regauth-d59d1c36",
			},
			checkFn: func(t *testing.T, spec corev1.PodSpec, imageBuild, gitClone corev1.Container) {
				if !hasVolume(spec, "registry-auth") {
					t.Error("registry-auth volume must be present when RegistryAuthSecret is set")
				}
				if !hasMountAt(imageBuild, "registry-auth", "/home/canette/.docker") {
					t.Error("image-build must mount registry-auth at /home/canette/.docker")
				}
				if findEnv(t, imageBuild, "DOCKER_CONFIG") != "/home/canette/.docker" {
					t.Error("DOCKER_CONFIG must point at the mount so buildctl forwards credentials to buildkitd")
				}
				if spec.ServiceAccountName != "" {
					t.Errorf("ServiceAccountName = %q, want empty — build job pod needs no SA", spec.ServiceAccountName)
				}
				if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
					t.Error("AutomountServiceAccountToken must be false")
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			job := BuildJob(
				testDeploymentID, testProjectSlug, testAppSlug, testCommitSha,
				testGitURL, testGitBranch, testAppPath,
				tc.credType, tc.credSecretName,
				testCanetteCfg,
				tc.cfg,
			)

			// --- Job metadata ---
			if job.Name != JobName(testDeploymentID) {
				t.Errorf("job.Name = %q, want %q", job.Name, JobName(testDeploymentID))
			}
			if job.Namespace != tc.cfg.Namespace {
				t.Errorf("job.Namespace = %q, want %q", job.Namespace, tc.cfg.Namespace)
			}
			if job.Labels["canette.dev/deployment"] != testDeploymentID {
				t.Errorf("label canette.dev/deployment = %q, want %q", job.Labels["canette.dev/deployment"], testDeploymentID)
			}
			if job.Labels["canette.dev/component"] != "builder" {
				t.Errorf("label canette.dev/component = %q, want 'builder'", job.Labels["canette.dev/component"])
			}
			if job.Labels["app.kubernetes.io/managed-by"] != "canette" {
				t.Errorf("label app.kubernetes.io/managed-by = %q, want 'canette'", job.Labels["app.kubernetes.io/managed-by"])
			}
			if job.Annotations["canette.dev/deployment-id"] != testDeploymentID {
				t.Errorf("annotation canette.dev/deployment-id = %q, want %q", job.Annotations["canette.dev/deployment-id"], testDeploymentID)
			}

			// --- Job spec ---
			if job.Spec.TTLSecondsAfterFinished == nil || *job.Spec.TTLSecondsAfterFinished != 600 {
				t.Error("TTLSecondsAfterFinished must be 600")
			}
			if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 0 {
				t.Error("BackoffLimit must be 0")
			}

			podSpec := job.Spec.Template.Spec
			if podSpec.RestartPolicy != corev1.RestartPolicyNever {
				t.Errorf("RestartPolicy = %q, want Never", podSpec.RestartPolicy)
			}

			// --- workspace volume ---
			if !hasVolume(podSpec, "workspace") {
				t.Fatal("workspace volume missing")
			}
			var wsVol *corev1.Volume
			for i := range podSpec.Volumes {
				if podSpec.Volumes[i].Name == "workspace" {
					wsVol = &podSpec.Volumes[i]
				}
			}
			if wsVol.EmptyDir == nil || wsVol.EmptyDir.SizeLimit == nil {
				t.Fatal("workspace volume must be an EmptyDir with SizeLimit")
			}
			wantSize := resource.MustParse("500Mi")
			if wsVol.EmptyDir.SizeLimit.Cmp(wantSize) != 0 {
				t.Errorf("workspace SizeLimit = %v, want 500Mi", wsVol.EmptyDir.SizeLimit)
			}

			// --- init container (git-clone) ---
			if len(podSpec.InitContainers) != 1 {
				t.Fatalf("want 1 init container, got %d", len(podSpec.InitContainers))
			}
			gitClone := podSpec.InitContainers[0]
			if gitClone.Name != "git-clone" {
				t.Errorf("init container name = %q, want 'git-clone'", gitClone.Name)
			}
			if gitClone.Image != tc.cfg.GitInitImage {
				t.Errorf("git-clone image = %q, want %q", gitClone.Image, tc.cfg.GitInitImage)
			}
			if findEnv(t, gitClone, "GIT_URL") != testGitURL {
				t.Error("GIT_URL mismatch")
			}
			if findEnv(t, gitClone, "GIT_REF") != testGitBranch {
				t.Error("GIT_REF mismatch")
			}
			if !hasMountAt(gitClone, "workspace", "/workspace") {
				t.Error("git-clone must mount workspace at /workspace")
			}
			if !hasMountAt(gitClone, "git-credentials", "/git-credentials") {
				t.Error("git-clone must mount git-credentials at /git-credentials")
			}

			// --- main container (image-build) ---
			if len(podSpec.Containers) != 1 {
				t.Fatalf("want 1 container, got %d", len(podSpec.Containers))
			}
			imageBuild := podSpec.Containers[0]
			if imageBuild.Name != "image-build" {
				t.Errorf("container name = %q, want 'image-build'", imageBuild.Name)
			}
			if imageBuild.Image != tc.cfg.BuilderImage {
				t.Errorf("image-build image = %q, want %q", imageBuild.Image, tc.cfg.BuilderImage)
			}
			if findEnv(t, imageBuild, "APP_NAME") != testProjectSlug+"/"+testAppSlug {
				t.Errorf("APP_NAME = %q, want %q", findEnv(t, imageBuild, "APP_NAME"), testProjectSlug+"/"+testAppSlug)
			}
			if !hasMountAt(imageBuild, "workspace", "/workspace") {
				t.Error("image-build must mount workspace at /workspace")
			}

			// --- resource requests/limits ---
			cpuReq := imageBuild.Resources.Requests[corev1.ResourceCPU]
			if cpuReq.Cmp(resource.MustParse("250m")) != 0 {
				t.Errorf("image-build CPU request = %v, want 250m", cpuReq)
			}
			memReq := imageBuild.Resources.Requests[corev1.ResourceMemory]
			if memReq.Cmp(resource.MustParse("256Mi")) != 0 {
				t.Errorf("image-build memory request = %v, want 256Mi", memReq)
			}
			cpuLim := imageBuild.Resources.Limits[corev1.ResourceCPU]
			if cpuLim.Cmp(resource.MustParse("1")) != 0 {
				t.Errorf("image-build CPU limit = %v, want 1", cpuLim)
			}
			memLim := imageBuild.Resources.Limits[corev1.ResourceMemory]
			if memLim.Cmp(resource.MustParse("1Gi")) != 0 {
				t.Errorf("image-build memory limit = %v, want 1Gi", memLim)
			}

			// --- case-specific checks ---
			tc.checkFn(t, podSpec, imageBuild, gitClone)
		})
	}
}

func TestBuildJob_CANETTECONFIGEncoding(t *testing.T) {
	cfg := "runtime:\n  port: 8080\nreplicas: 2\n"
	job := BuildJob(
		testDeploymentID, testProjectSlug, testAppSlug, testCommitSha,
		testGitURL, testGitBranch, testAppPath,
		"none", "", cfg, baseCfg,
	)

	imageBuild := job.Spec.Template.Spec.Containers[0]
	encoded := findEnv(t, imageBuild, "CANETTE_CONFIG")

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("CANETTE_CONFIG is not valid base64: %v", err)
	}
	if string(decoded) != cfg {
		t.Errorf("CANETTE_CONFIG decoded = %q, want %q", string(decoded), cfg)
	}
}


func TestBuildJob_SecurityContext(t *testing.T) {
	job := BuildJob(
		testDeploymentID, testProjectSlug, testAppSlug, testCommitSha,
		testGitURL, testGitBranch, testAppPath,
		"none", "", testCanetteCfg, baseCfg,
	)

	// --- Job-level deadline ---
	if job.Spec.ActiveDeadlineSeconds == nil {
		t.Fatal("ActiveDeadlineSeconds must be set")
	}
	if *job.Spec.ActiveDeadlineSeconds != 1800 {
		t.Errorf("ActiveDeadlineSeconds = %d, want 1800", *job.Spec.ActiveDeadlineSeconds)
	}

	podSpec := job.Spec.Template.Spec

	// --- No K8s API token ---
	if podSpec.AutomountServiceAccountToken == nil || *podSpec.AutomountServiceAccountToken {
		t.Error("AutomountServiceAccountToken must be explicitly false")
	}

	// --- Pod security context ---
	sc := podSpec.SecurityContext
	if sc == nil {
		t.Fatal("pod SecurityContext must be set")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Error("RunAsNonRoot must be true")
	}
	if sc.RunAsUser == nil || *sc.RunAsUser != 10001 {
		t.Errorf("RunAsUser = %v, want 1000", sc.RunAsUser)
	}
	if sc.RunAsGroup == nil || *sc.RunAsGroup != 10001 {
		t.Errorf("RunAsGroup = %v, want 1000", sc.RunAsGroup)
	}
	if sc.FSGroup == nil || *sc.FSGroup != 10001 {
		t.Errorf("FsGroup = %v, want 1000", sc.FSGroup)
	}
	if sc.SeccompProfile == nil {
		t.Fatal("SeccompProfile must be set")
	}
	if sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Errorf("SeccompProfile.Type = %q, want RuntimeDefault", sc.SeccompProfile.Type)
	}

	// --- Container security contexts ---
	if len(podSpec.InitContainers) != 1 {
		t.Fatalf("want 1 init container, got %d", len(podSpec.InitContainers))
	}
	gitCloneSC := podSpec.InitContainers[0].SecurityContext
	if gitCloneSC == nil || gitCloneSC.AllowPrivilegeEscalation == nil || *gitCloneSC.AllowPrivilegeEscalation {
		t.Error("git-clone: AllowPrivilegeEscalation must be explicitly false")
	}

	if len(podSpec.Containers) != 1 {
		t.Fatalf("want 1 container, got %d", len(podSpec.Containers))
	}
	imageBuildSC := podSpec.Containers[0].SecurityContext
	if imageBuildSC == nil || imageBuildSC.AllowPrivilegeEscalation == nil || *imageBuildSC.AllowPrivilegeEscalation {
		t.Error("image-build: AllowPrivilegeEscalation must be explicitly false")
	}
}
