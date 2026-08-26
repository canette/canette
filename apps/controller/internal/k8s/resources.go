// Package k8s builds Kubernetes resource manifests for app deployments.
package k8s

import (
	"fmt"
	"path"

	libk8s "canette.dev/lib/k8s"
)

// AppResources holds all K8s objects needed to deploy one app.
type AppResources struct {
	Namespace       map[string]interface{}
	Secret          map[string]interface{} // nil when no secrets
	ImagePullSecret map[string]interface{} // nil when imagePullSecrets not enabled
	Deployment      map[string]interface{} // nil when IsCronJob
	Service         map[string]interface{} // nil when IsCronJob
	HTTPRoute       map[string]interface{} // nil when SkipHTTPRoute or IsCronJob
	CronJob         map[string]interface{} // nil unless IsCronJob
	PVCs            []map[string]interface{}
	ConfigMaps      []map[string]interface{}
	AuthgateSecret  map[string]interface{} // nil unless PasswordGate is enabled (never set for CronJobs)
	AppSlug         string                 // needed by apply.go to clean up a stale AuthgateSecret when AuthgateSecret is nil
}

// Resources holds resolved Kubernetes resource requests and limits.
type Resources struct {
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
}

// VolumeSpec describes a volume to mount in the app container.
type VolumeSpec struct {
	Name      string
	Type      string // "pvc" | "emptyDir" | "configmap"
	MountPath string
	Size      string // PVC (required) and optional emptyDir size limit
	Content   string // configmap only
}

// PasswordGateConfig describes the optional HTTP Basic Auth gate for a web
// app — a single shared password, not individual accounts, so there is no
// username: the authgate sidecar accepts any username alongside the correct
// password.
type PasswordGateConfig struct {
	Enabled      bool
	PasswordHash string // bcrypt hash, e.g. "$2b$10$..." — never a plaintext password
}

// DeployConfig carries everything needed to build resources.
type DeployConfig struct {
	ProjectID           string
	ProjectSlug         string
	ProjectOwner        string // user ID who created the project (may be empty)
	AppSlug             string
	ImageRef            string // full image reference including digest, e.g. "registry/proj/app@sha256:..."
	Port                int
	Replicas            int
	Resources           Resources
	EnvVars             map[string]string // plain-text env vars
	SecretData          map[string][]byte // decrypted secret values
	GatewayName         string
	GatewayNamespace    string
	ClusterDomain       string
	Command             []string // optional command override (canette.yaml runtime.command)
	SkipHTTPRoute       bool     // true when deployment_type == "private" or ingress.enabled == false
	IsCronJob           bool     // true when deployment_type == "cronjob"
	Schedule            string   // cron expression, only used when IsCronJob
	ImagePullSecretName string   // Name of the imagePullSecret to reference in pod spec
	ImagePullSecretData []byte   // raw .dockerconfigjson content; Go's JSON marshaler base64-encodes []byte in data fields
	Volumes             []VolumeSpec
	ExtraHostnames      []string // admin-assigned custom hostnames, added to the HTTPRoute alongside the platform-generated one
	CommitSha           string   // git commit SHA for the deployed revision, surfaced as app.kubernetes.io/version
	DeploymentID        string   // deployments.id row that triggered this apply, surfaced as an annotation
	PasswordGate        PasswordGateConfig
	AuthgateImage       string // canette-authgate sidecar image ref, only read when PasswordGate.Enabled
}

// shortSHA returns the first 7 characters of a commit SHA for display as a version label,
// or the input unchanged if shorter, or "" if empty.
func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// resourceMeta builds a top-level metadata block, omitting the annotations key when nil.
func resourceMeta(name, namespace string, labels, annotations map[string]interface{}) map[string]interface{} {
	meta := map[string]interface{}{
		"name":      name,
		"namespace": namespace,
		"labels":    labels,
	}
	if annotations != nil {
		meta["annotations"] = annotations
	}
	return meta
}

// templateMeta builds a pod template metadata block, omitting the annotations key when nil.
func templateMeta(labels, annotations map[string]interface{}) map[string]interface{} {
	meta := map[string]interface{}{"labels": labels}
	if annotations != nil {
		meta["annotations"] = annotations
	}
	return meta
}

// AppNamespace returns the K8s namespace for a project: can-{id[:8]}-{slug[:50]}.
var AppNamespace = libk8s.AppNamespace

func secretName(appSlug string) string {
	return appSlug + "-secrets"
}

// authgateSidecarPort is the internal-only port the password-gate authgate
// sidecar listens on. MUST stay in sync with
// apps/api/src/services/reserved-ports.ts' AUTHGATE_SIDECAR_PORT — the
// Service's targetPort switches to this value when the gate is enabled, and
// apps may never declare this as their own runtime port (enforced in the
// API's createApp/updateApp port validation).
const authgateSidecarPort = 39191

const authgateContainerName = "authgate"

const authgateHealthzPath = "/.canette-gate/healthz"

func authgateSecretName(appSlug string) string {
	return appSlug + "-authgate"
}

// BuildResources constructs all K8s resource manifests for an app deployment.
func BuildResources(cfg DeployConfig) AppResources {
	ns := AppNamespace(cfg.ProjectID, cfg.ProjectSlug)

	// selectorLabels are stable across redeploys of the same app - used only for
	// Deployment.spec.selector.matchLabels and Service.spec.selector, both of which must
	// never contain a per-deploy value (selector is immutable once a Deployment is created).
	selectorLabels := map[string]interface{}{
		libk8s.LabelManagedBy:   libk8s.LabelManagedByVal,
		libk8s.LabelProject:     cfg.ProjectSlug,
		libk8s.LabelProjectID:   cfg.ProjectID,
		libk8s.LabelApp:         cfg.AppSlug,
		libk8s.LabelK8sName:     cfg.AppSlug,
		libk8s.LabelK8sInstance: cfg.AppSlug,
	}

	// resourceLabels is a superset used for every resource's own metadata.labels and for pod
	// template labels - safe to include per-deploy values like the version label here.
	resourceLabels := make(map[string]interface{}, len(selectorLabels)+2)
	for k, v := range selectorLabels {
		resourceLabels[k] = v
	}
	resourceLabels[libk8s.LabelK8sPartOf] = cfg.ProjectSlug
	if sha := shortSHA(cfg.CommitSha); sha != "" {
		resourceLabels[libk8s.LabelK8sVersion] = sha
	}
	labels := resourceLabels

	var annotations map[string]interface{}
	if cfg.DeploymentID != "" {
		annotations = map[string]interface{}{libk8s.AnnotDeploymentID: cfg.DeploymentID}
	}

	nsLabels := map[string]interface{}{
		libk8s.LabelManagedBy: libk8s.LabelManagedByVal,
		libk8s.LabelProject:   cfg.ProjectSlug,
		libk8s.LabelProjectID: cfg.ProjectID,
	}
	if cfg.ProjectOwner != "" {
		nsLabels[libk8s.LabelOwner] = cfg.ProjectOwner
	}

	namespace := map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata": map[string]interface{}{
			"name":   ns,
			"labels": nsLabels,
		},
	}

	var secretObj map[string]interface{}
	if len(cfg.SecretData) > 0 {
		data := make(map[string]interface{}, len(cfg.SecretData))
		for k, v := range cfg.SecretData {
			data[k] = v
		}
		secretObj = map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"metadata": map[string]interface{}{
				"name":      secretName(cfg.AppSlug),
				"namespace": ns,
				"labels":    labels,
			},
			"data": data,
		}
	}

	// Create imagePullSecret if enabled and credentials exist
	var imagePullSecret map[string]interface{}
	if cfg.ImagePullSecretName != "" && len(cfg.ImagePullSecretData) > 0 {
		imagePullSecret = map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"metadata": map[string]interface{}{
				"name":      cfg.ImagePullSecretName,
				"namespace": ns,
				"labels":    labels,
			},
			"type": "kubernetes.io/dockerconfigjson",
			"data": map[string]interface{}{
				".dockerconfigjson": cfg.ImagePullSecretData,
			},
		}
	}

	port := cfg.Port
	if port == 0 {
		port = 3000
	}

	// Build the env list. For non-CronJob apps, inject PORT first so railpack-built
	// apps bind to the configured port. CronJobs typically don't listen on a port.
	var envList []interface{}
	if !cfg.IsCronJob {
		envList = append(envList, map[string]interface{}{"name": "PORT", "value": fmt.Sprintf("%d", port)})
	}
	for k, v := range cfg.EnvVars {
		envList = append(envList, map[string]interface{}{
			"name":  k,
			"value": v,
		})
	}

	resourceSpec := map[string]interface{}{
		"requests": map[string]interface{}{
			"cpu":    cfg.Resources.CPURequest,
			"memory": cfg.Resources.MemoryRequest,
		},
		"limits": map[string]interface{}{
			"cpu":    cfg.Resources.CPULimit,
			"memory": cfg.Resources.MemoryLimit,
		},
	}

	containerSpec := map[string]interface{}{
		"name":      cfg.AppSlug,
		"image":     cfg.ImageRef,
		"env":       envList,
		"resources": resourceSpec,
	}
	if len(cfg.Command) > 0 {
		containerSpec["command"] = cfg.Command
	}
	if !cfg.IsCronJob {
		containerSpec["ports"] = []interface{}{
			map[string]interface{}{"containerPort": port, "protocol": "TCP"},
		}
	}
	if len(cfg.SecretData) > 0 {
		containerSpec["envFrom"] = []interface{}{
			map[string]interface{}{
				"secretRef": map[string]interface{}{"name": secretName(cfg.AppSlug)},
			},
		}
	}

	// Build volume and volumeMount entries for each configured volume.
	var pvcs []map[string]interface{}
	var configMaps []map[string]interface{}
	var podVolumes []interface{}
	var volumeMounts []interface{}

	for _, v := range cfg.Volumes {
		switch v.Type {
		case "pvc":
			pvcName := cfg.AppSlug + "-" + v.Name
			pvcs = append(pvcs, map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "PersistentVolumeClaim",
				"metadata": map[string]interface{}{
					"name":      pvcName,
					"namespace": ns,
					"labels":    labels,
				},
				"spec": map[string]interface{}{
					"accessModes": []interface{}{"ReadWriteOnce"},
					"resources": map[string]interface{}{
						"requests": map[string]interface{}{"storage": v.Size},
					},
				},
			})
			podVolumes = append(podVolumes, map[string]interface{}{
				"name":                  v.Name,
				"persistentVolumeClaim": map[string]interface{}{"claimName": pvcName},
			})
			volumeMounts = append(volumeMounts, map[string]interface{}{
				"name": v.Name, "mountPath": v.MountPath,
			})

		case "emptyDir":
			emptyDir := map[string]interface{}{}
			if v.Size != "" {
				emptyDir["sizeLimit"] = v.Size
			}
			podVolumes = append(podVolumes, map[string]interface{}{
				"name": v.Name, "emptyDir": emptyDir,
			})
			volumeMounts = append(volumeMounts, map[string]interface{}{
				"name": v.Name, "mountPath": v.MountPath,
			})

		case "configmap":
			cmName := cfg.AppSlug + "-" + v.Name + "-cfg"
			filename := path.Base(v.MountPath)
			configMaps = append(configMaps, map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "ConfigMap",
				"metadata": map[string]interface{}{
					"name":      cmName,
					"namespace": ns,
					"labels":    labels,
				},
				"data": map[string]interface{}{filename: v.Content},
			})
			podVolumes = append(podVolumes, map[string]interface{}{
				"name": v.Name,
				"configMap": map[string]interface{}{
					"name":  cmName,
					"items": []interface{}{map[string]interface{}{"key": filename, "path": filename}},
				},
			})
			volumeMounts = append(volumeMounts, map[string]interface{}{
				"name": v.Name, "mountPath": v.MountPath, "subPath": filename,
			})
		}
	}

	if len(volumeMounts) > 0 {
		containerSpec["volumeMounts"] = volumeMounts
	}

	podSpec := map[string]interface{}{
		"containers": []interface{}{containerSpec},
	}

	// Password-gate sidecar: only meaningful for apps with a Service/HTTPRoute,
	// so it's skipped entirely for CronJobs even if PasswordGate.Enabled is set
	// upstream (defense-in-depth alongside the store-layer guard).
	var authgateSecretObj map[string]interface{}
	if cfg.PasswordGate.Enabled && !cfg.IsCronJob {
		// The password hash is a plain env var value (via envFrom below), never
		// interpolated into a config file — unlike the old rendered Caddyfile,
		// there is no config-syntax injection surface to guard here.
		authgateSecretObj = map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Secret",
			"metadata": map[string]interface{}{
				"name":      authgateSecretName(cfg.AppSlug),
				"namespace": ns,
				"labels":    labels,
			},
			"data": map[string]interface{}{
				"PASSWORD_HASH": []byte(cfg.PasswordGate.PasswordHash),
			},
		}
		authgateContainer := map[string]interface{}{
			"name":  authgateContainerName,
			"image": cfg.AuthgateImage,
			"ports": []interface{}{
				map[string]interface{}{"containerPort": authgateSidecarPort, "protocol": "TCP"},
			},
			"env": []interface{}{
				map[string]interface{}{"name": "AUTHGATE_UPSTREAM_PORT", "value": fmt.Sprintf("%d", port)},
				map[string]interface{}{"name": "AUTHGATE_APP_SLUG", "value": cfg.AppSlug},
			},
			// prefix: "AUTHGATE_" makes the Secret's PASSWORD_HASH key surface as
			// the AUTHGATE_PASSWORD_HASH env var authgate's main.go reads.
			"envFrom": []interface{}{
				map[string]interface{}{
					"secretRef": map[string]interface{}{"name": authgateSecretName(cfg.AppSlug)},
					"prefix":    "AUTHGATE_",
				},
			},
			// runAsUser is required alongside runAsNonRoot: the FROM scratch
			// authgate image has no USER directive (defaults to UID 0), so without
			// an explicit non-root UID here the kubelet refuses to start the pod
			// ("container has runAsNonRoot and image will run as root"). Matches
			// the same runAsUser: 65534 (nobody) convention as the controller and
			// logstreamer Deployments (charts/canette/templates/*/deployment.yaml).
			"securityContext": map[string]interface{}{
				"runAsNonRoot":             true,
				"runAsUser":                65534,
				"allowPrivilegeEscalation": false,
				"readOnlyRootFilesystem":   true,
				"capabilities":             map[string]interface{}{"drop": []interface{}{"ALL"}},
			},
			"livenessProbe": map[string]interface{}{
				"httpGet": map[string]interface{}{"path": authgateHealthzPath, "port": authgateSidecarPort},
			},
			"readinessProbe": map[string]interface{}{
				"httpGet": map[string]interface{}{"path": authgateHealthzPath, "port": authgateSidecarPort},
			},
		}
		podSpec["containers"] = append(podSpec["containers"].([]interface{}), authgateContainer)
	}

	if len(podVolumes) > 0 {
		podSpec["volumes"] = podVolumes
	}
	if cfg.ImagePullSecretName != "" {
		podSpec["imagePullSecrets"] = []interface{}{
			map[string]interface{}{"name": cfg.ImagePullSecretName},
		}
	}

	var deployment, service, httpRoute, cronJob map[string]interface{}

	if cfg.IsCronJob {
		podSpec["restartPolicy"] = "OnFailure"
		cronJob = map[string]interface{}{
			"apiVersion": "batch/v1",
			"kind":       "CronJob",
			"metadata":   resourceMeta(cfg.AppSlug, ns, labels, annotations),
			"spec": map[string]interface{}{
				"schedule":                   cfg.Schedule,
				"concurrencyPolicy":          "Forbid",
				"failedJobsHistoryLimit":     3,
				"successfulJobsHistoryLimit": 3,
				"jobTemplate": map[string]interface{}{
					"spec": map[string]interface{}{
						"template": map[string]interface{}{
							"metadata": templateMeta(labels, annotations),
							"spec":     podSpec,
						},
					},
				},
			},
		}
	} else {
		deployment = map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata":   resourceMeta(cfg.AppSlug, ns, labels, annotations),
			"spec": map[string]interface{}{
				"replicas": cfg.Replicas,
				"selector": map[string]interface{}{
					"matchLabels": selectorLabels,
				},
				"template": map[string]interface{}{
					"metadata": templateMeta(labels, annotations),
					"spec":     podSpec,
				},
			},
		}

		// targetPort routes through the authgate sidecar when the password gate
		// is enabled; the external port (and thus the HTTPRoute, which targets
		// the Service by name/port and needs no changes) is unaffected.
		targetPort := port
		if cfg.PasswordGate.Enabled {
			targetPort = authgateSidecarPort
		}
		service = map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Service",
			"metadata": map[string]interface{}{
				"name":      cfg.AppSlug,
				"namespace": ns,
				"labels":    labels,
			},
			"spec": map[string]interface{}{
				"selector": selectorLabels,
				"ports": []interface{}{
					map[string]interface{}{
						"port":       port,
						"targetPort": targetPort,
						"protocol":   "TCP",
					},
				},
			},
		}

		if !cfg.SkipHTTPRoute {
			hostname := fmt.Sprintf("%s-%s.%s", cfg.AppSlug, cfg.ProjectSlug, cfg.ClusterDomain)
			// Extra hostnames route to the same backend via the same HTTPRoute — Gateway
			// API matches on any listed hostname, so no separate route objects are needed.
			// TLS is out of scope: canette only writes spec.hostnames here, never touches
			// the Gateway's listener certificates, so HTTPS for a custom hostname requires
			// a matching cert to already exist on the Gateway (admin's responsibility).
			hostnames := make([]interface{}, 0, 1+len(cfg.ExtraHostnames))
			hostnames = append(hostnames, hostname)
			for _, h := range cfg.ExtraHostnames {
				hostnames = append(hostnames, h)
			}
			httpRoute = map[string]interface{}{
				"apiVersion": "gateway.networking.k8s.io/v1",
				"kind":       "HTTPRoute",
				"metadata": map[string]interface{}{
					"name":      cfg.AppSlug,
					"namespace": ns,
					"labels":    labels,
				},
				"spec": map[string]interface{}{
					"parentRefs": []interface{}{
						map[string]interface{}{
							"group":     "gateway.networking.k8s.io",
							"kind":      "Gateway",
							"name":      cfg.GatewayName,
							"namespace": cfg.GatewayNamespace,
						},
					},
					"hostnames": hostnames,
					"rules": []interface{}{
						map[string]interface{}{
							"matches": []interface{}{
								map[string]interface{}{
									"path": map[string]interface{}{
										"type":  "PathPrefix",
										"value": "/",
									},
								},
							},
							"backendRefs": []interface{}{
								map[string]interface{}{
									"name": cfg.AppSlug,
									"port": port,
								},
							},
						},
					},
				},
			}
		}
	}

	return AppResources{
		Namespace:       namespace,
		Secret:          secretObj,
		ImagePullSecret: imagePullSecret,
		Deployment:      deployment,
		Service:         service,
		HTTPRoute:       httpRoute,
		CronJob:         cronJob,
		PVCs:            pvcs,
		ConfigMaps:      configMaps,
		AuthgateSecret:  authgateSecretObj,
		AppSlug:         cfg.AppSlug,
	}
}
