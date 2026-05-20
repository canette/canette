// Package k8s builds Kubernetes resource manifests for app deployments.
package k8s

import (
	"fmt"

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
}

// Resources holds resolved Kubernetes resource requests and limits.
type Resources struct {
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
}

// DeployConfig carries everything needed to build resources.
type DeployConfig struct {
	ProjectID           string
	ProjectSlug         string
	ProjectOwner        string            // user ID who created the project (may be empty)
	AppSlug             string
	ImageRef            string            // full image reference including digest, e.g. "registry/proj/app@sha256:..."
	Port                int
	Replicas            int
	Resources           Resources
	EnvVars             map[string]string // plain-text env vars
	SecretData          map[string][]byte // decrypted secret values
	GatewayName         string
	GatewayNamespace    string
	ClusterDomain       string
	Command             []string // optional command override (canette.yaml runtime.command)
	SkipHTTPRoute       bool   // true when deployment_type == "private" or ingress.enabled == false
	IsCronJob           bool   // true when deployment_type == "cronjob"
	Schedule            string // cron expression, only used when IsCronJob
	ImagePullSecretName string // Name of the imagePullSecret to reference in pod spec
	ImagePullSecretData []byte // raw .dockerconfigjson content; Go's JSON marshaler base64-encodes []byte in data fields
}

// AppNamespace returns the K8s namespace for a project: can-{id[:8]}-{slug[:50]}.
var AppNamespace = libk8s.AppNamespace

func secretName(appSlug string) string {
	return appSlug + "-secrets"
}

// BuildResources constructs all K8s resource manifests for an app deployment.
func BuildResources(cfg DeployConfig) AppResources {
	ns := AppNamespace(cfg.ProjectID, cfg.ProjectSlug)
	labels := map[string]interface{}{
		libk8s.LabelManagedBy:  libk8s.LabelManagedByVal,
		libk8s.LabelProject:    cfg.ProjectSlug,
		libk8s.LabelProjectID:  cfg.ProjectID,
		libk8s.LabelApp:        cfg.AppSlug,
	}

	nsLabels := map[string]interface{}{
		libk8s.LabelManagedBy:  libk8s.LabelManagedByVal,
		libk8s.LabelProject:    cfg.ProjectSlug,
		libk8s.LabelProjectID:  cfg.ProjectID,
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

	podSpec := map[string]interface{}{
		"containers": []interface{}{containerSpec},
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
			"metadata": map[string]interface{}{
				"name":      cfg.AppSlug,
				"namespace": ns,
				"labels":    labels,
			},
			"spec": map[string]interface{}{
				"schedule":                    cfg.Schedule,
				"concurrencyPolicy":           "Forbid",
				"failedJobsHistoryLimit":      3,
				"successfulJobsHistoryLimit":  3,
				"jobTemplate": map[string]interface{}{
					"spec": map[string]interface{}{
						"template": map[string]interface{}{
							"metadata": map[string]interface{}{"labels": labels},
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
			"metadata": map[string]interface{}{
				"name":      cfg.AppSlug,
				"namespace": ns,
				"labels":    labels,
			},
			"spec": map[string]interface{}{
				"replicas": cfg.Replicas,
				"selector": map[string]interface{}{
					"matchLabels": labels,
				},
				"template": map[string]interface{}{
					"metadata": map[string]interface{}{"labels": labels},
					"spec":     podSpec,
				},
			},
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
				"selector": labels,
				"ports": []interface{}{
					map[string]interface{}{
						"port":       port,
						"targetPort": port,
						"protocol":   "TCP",
					},
				},
			},
		}

		if !cfg.SkipHTTPRoute {
			hostname := fmt.Sprintf("%s-%s.%s", cfg.AppSlug, cfg.ProjectSlug, cfg.ClusterDomain)
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
					"hostnames": []interface{}{hostname},
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
	}
}
