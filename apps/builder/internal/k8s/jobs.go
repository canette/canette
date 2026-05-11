// Package k8s constructs and creates Kubernetes resources for the builder.
// All object shapes are derived from labs/build-job-example.yaml.
package k8s

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// BuildConfig holds operator-level configuration injected from environment variables.
type BuildConfig struct {
	Namespace          string
	ImageRepo          string // e.g. "registry.canette-system.svc.cluster.local:5000/"
	BuildkitdAddr      string // e.g. "tcp://buildkitd.canette-build.svc.cluster.local:1234"
	BuilderImage       string // pre-built railpack+buildctl+build-binary image
	GitInitImage       string // image containing the git-init binary (e.g. "my-registry/canette-builder-git-init:latest")
	RegistryAuthSecret string // optional: Secret name containing .dockerconfigjson for registry push auth
	RegistryAuthType   string // "irsa" or "static" — controls service account and token mounting for build jobs
}

// JobName returns the deterministic K8s Job name for a deployment ID.
func JobName(deploymentID string) string {
	short := deploymentID
	if len(short) > 8 {
		short = short[:8]
	}
	return "can-build-" + short
}

// ImageTag returns the full image reference for a build.
// Image path is projectSlug/appSlug to avoid collisions across projects.
// Tag is "git-" + first 7 chars of commitSha.
func ImageTag(cfg BuildConfig, projectSlug, appSlug, commitSha string) string {
	sha := commitSha
	if len(sha) > 7 {
		sha = sha[:7]
	}
	return cfg.ImageRepo + projectSlug + "/" + appSlug + ":git-" + sha
}

// CredSecretName returns the name of the per-build git credential Secret.
func CredSecretName(deploymentID string) string {
	short := deploymentID
	if len(short) > 8 {
		short = short[:8]
	}
	return "can-gitcred-" + short
}

// RegistryAuthSecretName returns the name of the per-build registry auth Secret.
func RegistryAuthSecretName(deploymentID string) string {
	short := deploymentID
	if len(short) > 8 {
		short = short[:8]
	}
	return "can-regauth-" + short
}

// CreateRegistryAuthSecret creates a per-build Secret containing a docker config.json
// with the provided credentials. buildctl reads this and forwards auth to buildkitd.
func CreateRegistryAuthSecret(ctx context.Context, client kubernetes.Interface, namespace, name, configJSON string) error {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "canette",
				"canette.dev/component":        "builder",
			},
		},
		Type: corev1.SecretTypeDockerConfigJson,
		Data: map[string][]byte{
			corev1.DockerConfigJsonKey: []byte(configJSON),
		},
	}
	if _, err := client.CoreV1().Secrets(namespace).Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create registry auth secret: %w", err)
	}
	return nil
}

// BuildJob constructs a batchv1.Job that clones a git repo and builds it with railpack.
// credSecretName may be empty when no git credentials are needed.
// canetteConfig is the UI-configured canette.yaml YAML string (may be empty); it is
// passed into the container as CANETTE_CONFIG so the build binary can use it as a base
// layer before the repo's canette.yaml overrides it.
func ptrBool(v bool) *bool   { return &v }
func ptrInt32(v int32) *int32 { return &v }
func ptrInt64(v int64) *int64 { return &v }

// pullPolicy returns Always for mutable tags (latest, edge) so the node never
// serves a stale cached image. Otherwise the cluster default (IfNotPresent) applies.
func pullPolicy(image string) corev1.PullPolicy {
	if strings.HasSuffix(image, ":edge") || strings.HasSuffix(image, ":latest") {
		return corev1.PullAlways
	}
	return corev1.PullIfNotPresent
}

func BuildJob(
	deploymentID, projectSlug, appSlug, commitSha, gitURL, gitBranch, appPath string,
	credType string, // "none", "pat", or "ssh_key"
	credSecretName string,
	canetteConfig string,
	cfg BuildConfig,
) *batchv1.Job {
	jobName := JobName(deploymentID)
	optional := true

	labels := map[string]string{
		"app.kubernetes.io/managed-by": "canette",
		"canette.dev/component":        "builder",
		"canette.dev/deployment":       deploymentID,
	}

	workspaceVolumeQuota := resource.MustParse("500Mi")

	volumes := []corev1.Volume{
		{
			Name: "workspace",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{
					SizeLimit: &workspaceVolumeQuota,
				},
			},
		},
		{
			Name: "git-credentials",
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: func() string {
						if credSecretName != "" {
							return credSecretName
						}
						return "can-gitcred-placeholder" // never mounted when optional=true and missing
					}(),
					Optional: &optional,
				},
			},
		},
	}
	if cfg.RegistryAuthSecret != "" {
		volumes = append(volumes, corev1.Volume{
			Name: "registry-auth",
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: cfg.RegistryAuthSecret,
					Items: []corev1.KeyToPath{
						{Key: ".dockerconfigjson", Path: "config.json"},
					},
				},
			},
		})
	}

	containerSecCtx := &corev1.SecurityContext{
		AllowPrivilegeEscalation: ptrBool(false),
	}

	initContainers := []corev1.Container{
		{
			Name:            "git-clone",
			Image:           cfg.GitInitImage,
			ImagePullPolicy: pullPolicy(cfg.GitInitImage),
			Env: []corev1.EnvVar{
				{Name: "GIT_URL", Value: gitURL},
				{Name: "GIT_REF", Value: gitBranch},
				{Name: "GIT_CREDENTIAL_TYPE", Value: credType},
			},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "workspace", MountPath: "/workspace"},
				{Name: "git-credentials", MountPath: "/git-credentials", ReadOnly: true},
			},
			SecurityContext: containerSecCtx,
		},
	}

	containers := []corev1.Container{
		{
			Name:            "image-build",
			Image:           cfg.BuilderImage,
			ImagePullPolicy: pullPolicy(cfg.BuilderImage),
			Command:         []string{"/usr/local/bin/canette-build"},
			Env: []corev1.EnvVar{
				{Name: "APP_NAME", Value: projectSlug + "/" + appSlug},
				{Name: "APP_PATH", Value: appPath},
				{Name: "IMAGE_REPO", Value: cfg.ImageRepo},
				{Name: "BUILDKIT_HOST", Value: cfg.BuildkitdAddr},
				{Name: "CANETTE_CONFIG", Value: base64.StdEncoding.EncodeToString([]byte(canetteConfig))},
			},
			VolumeMounts: func() []corev1.VolumeMount {
				mounts := []corev1.VolumeMount{
					{Name: "workspace", MountPath: "/workspace", ReadOnly: true},
				}
				if cfg.RegistryAuthSecret != "" {
					mounts = append(mounts, corev1.VolumeMount{
						Name:      "registry-auth",
						MountPath: "/home/canette/.docker", // matches USER canette home in the image-build Dockerfile
						ReadOnly:  true,
					})
				}
				return mounts
			}(),
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("250m"),
					corev1.ResourceMemory: resource.MustParse("256Mi"),
				},
				Limits: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("1"),
					corev1.ResourceMemory: resource.MustParse("1Gi"),
				},
			},
			SecurityContext: containerSecCtx,
		},
	}

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: cfg.Namespace,
			Labels:    labels,
			Annotations: map[string]string{
				"canette.dev/deployment-id": deploymentID,
			},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: ptrInt32(600),
			BackoffLimit:            ptrInt32(0),
			ActiveDeadlineSeconds:   ptrInt64(1800),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptrBool(false),
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptrBool(true),
						RunAsUser:    ptrInt64(10001),
						RunAsGroup:   ptrInt64(10001),
						FSGroup:      ptrInt64(10001),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes:        volumes,
					InitContainers: initContainers,
					Containers:     containers,
				},
			},
		},
	}
}

// LogJobManifest logs the Job manifest as indented JSON at debug level.
// Call this immediately before submitting the Job to the API server.
func LogJobManifest(log *zap.Logger, job *batchv1.Job) {
	if !log.Core().Enabled(zap.DebugLevel) {
		return
	}
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		log.Warn("failed to marshal job manifest for debug logging", zap.Error(err))
		return
	}
	log.Debug("job manifest", zap.String("manifest", string(data)))
}

// CreateGitCredSecret creates a per-build Secret holding decrypted git credentials.
// For PAT: key "token". For SSH: keys "id_ed25519" and "known_hosts".
func CreateGitCredSecret(
	ctx context.Context,
	client kubernetes.Interface,
	namespace, name, credType, decryptedValue string,
	knownHosts *string,
) error {
	data := map[string][]byte{}
	switch credType {
	case "pat":
		data["token"] = []byte(decryptedValue)
	case "ssh_key":
		data["id_ed25519"] = []byte(decryptedValue)
		if knownHosts != nil {
			data["known_hosts"] = []byte(*knownHosts)
		}
	default:
		return fmt.Errorf("unknown credential type: %s", credType)
	}

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "canette",
				"canette.dev/component":        "builder",
			},
		},
		Data: data,
	}
	_, err := client.CoreV1().Secrets(namespace).Create(ctx, secret, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create git cred secret: %w", err)
	}
	return nil
}

// DeleteSecret removes a Secret, ignoring not-found errors.
func DeleteSecret(ctx context.Context, client kubernetes.Interface, namespace, name string) {
	_ = client.CoreV1().Secrets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
