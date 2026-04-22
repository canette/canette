// Package k8s builds Kubernetes resource manifests for app deployments.
package k8s

import (
	"fmt"
)

// AppResources holds all K8s objects needed to deploy one app.
type AppResources struct {
	Namespace  map[string]interface{}
	Secret     map[string]interface{} // nil when no secrets
	Deployment map[string]interface{}
	Service    map[string]interface{}
	HTTPRoute  map[string]interface{}
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
	ProjectID        string
	ProjectSlug      string
	ProjectOwner     string // user ID who created the project (may be empty)
	AppSlug          string
	ImageRef         string // full image reference including digest, e.g. "registry/proj/app@sha256:..."
	Port             int
	Replicas         int
	Resources        Resources
	EnvVars          map[string]string // plain-text env vars
	SecretData       map[string][]byte // decrypted secret values
	GatewayName      string
	GatewayNamespace string
	ClusterDomain    string
}

// AppNamespace returns the K8s namespace for a project: can-{id[:8]}-{slug[:50]}.
func AppNamespace(projectID, projectSlug string) string {
	idPart := projectID
	if len(idPart) > 8 {
		idPart = idPart[:8]
	}
	slug := projectSlug
	if len(slug) > 50 {
		slug = slug[:50]
	}
	return "can-" + idPart + "-" + slug
}

func secretName(appSlug string) string {
	return appSlug + "-secrets"
}

// BuildResources constructs all K8s resource manifests for an app deployment.
func BuildResources(cfg DeployConfig) AppResources {
	ns := AppNamespace(cfg.ProjectID, cfg.ProjectSlug)
	labels := map[string]interface{}{
		"app.kubernetes.io/managed-by": "canette",
		"canette.dev/project":          cfg.ProjectSlug,
		"canette.dev/project-id":       cfg.ProjectID,
		"canette.dev/app":              cfg.AppSlug,
	}

	nsLabels := map[string]interface{}{
		"app.kubernetes.io/managed-by": "canette",
		"canette.dev/project":          cfg.ProjectSlug,
		"canette.dev/project-id":       cfg.ProjectID,
	}
	if cfg.ProjectOwner != "" {
		nsLabels["canette.dev/owner"] = cfg.ProjectOwner
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

	// Build env list from plain-text vars
	envList := make([]interface{}, 0, len(cfg.EnvVars))
	for k, v := range cfg.EnvVars {
		envList = append(envList, map[string]interface{}{
			"name":  k,
			"value": v,
		})
	}

	port := cfg.Port
	if port == 0 {
		port = 3000
	}

	podSpec := map[string]interface{}{
		"containers": []interface{}{
			map[string]interface{}{
				"name":  cfg.AppSlug,
				"image": cfg.ImageRef,
				"ports": []interface{}{
					map[string]interface{}{"containerPort": port, "protocol": "TCP"},
				},
				"env": envList,
				"resources": map[string]interface{}{
					"requests": map[string]interface{}{
						"cpu":    cfg.Resources.CPURequest,
						"memory": cfg.Resources.MemoryRequest,
					},
					"limits": map[string]interface{}{
						"cpu":    cfg.Resources.CPULimit,
						"memory": cfg.Resources.MemoryLimit,
					},
				},
			},
		},
	}

	if len(cfg.SecretData) > 0 {
		container := podSpec["containers"].([]interface{})[0].(map[string]interface{})
		container["envFrom"] = []interface{}{
			map[string]interface{}{
				"secretRef": map[string]interface{}{
					"name": secretName(cfg.AppSlug),
				},
			},
		}
	}

	deployment := map[string]interface{}{
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

	service := map[string]interface{}{
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

	hostname := fmt.Sprintf("%s-%s.%s", cfg.AppSlug, cfg.ProjectSlug, cfg.ClusterDomain)
	httpRoute := map[string]interface{}{
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

	return AppResources{
		Namespace:  namespace,
		Secret:     secretObj,
		Deployment: deployment,
		Service:    service,
		HTTPRoute:  httpRoute,
	}
}
