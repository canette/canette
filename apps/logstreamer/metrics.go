package main

import (
	"context"
	"encoding/json"
	"net/http"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	libk8s "canette.dev/lib/k8s"
)

// podMetrics is the per-pod entry in the GET /metrics/usage response.
type podMetrics struct {
	Name                  string `json:"name"`
	Ready                 bool   `json:"ready"`
	Restarts              int32  `json:"restarts"`
	CPURequestMilli       *int64 `json:"cpuRequestMilli,omitempty"`
	CPULimitMilli         *int64 `json:"cpuLimitMilli,omitempty"`
	MemoryRequestBytes    *int64 `json:"memoryRequestBytes,omitempty"`
	MemoryLimitBytes      *int64 `json:"memoryLimitBytes,omitempty"`
	CPUUsageMilli         *int64 `json:"cpuUsageMilli,omitempty"`
	MemoryUsageBytes      *int64 `json:"memoryUsageBytes,omitempty"`
	LastTerminationReason string `json:"lastTerminationReason,omitempty"` // e.g. "OOMKilled", "Error"
	LastExitCode          *int32 `json:"lastExitCode,omitempty"`
}

type usageResponse struct {
	UsageAvailable         bool         `json:"usageAvailable"`
	UsageUnavailableReason string       `json:"usageUnavailableReason,omitempty"`
	Pods                   []podMetrics `json:"pods"`
}

// newMetricsRESTClient builds a raw REST client for the metrics.k8s.io aggregated API
// (metrics-server). We avoid the k8s.io/metrics module and decode the JSON ourselves,
// since the response shape (PodMetricsList) is small and stable.
func newMetricsRESTClient(restCfg *rest.Config) (rest.Interface, error) {
	cfg := *restCfg
	cfg.APIPath = "/apis"
	cfg.GroupVersion = &schema.GroupVersion{Group: "metrics.k8s.io", Version: "v1beta1"}
	cfg.NegotiatedSerializer = scheme.Codecs.WithoutConversion()
	return rest.RESTClientFor(&cfg)
}

type rawPodMetricsList struct {
	Items []rawPodMetrics `json:"items"`
}

type rawPodMetrics struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Containers []struct {
		Usage struct {
			CPU    string `json:"cpu"`
			Memory string `json:"memory"`
		} `json:"usage"`
	} `json:"containers"`
}

// fetchPodUsage queries metrics.k8s.io for current CPU/memory usage of pods matching
// the label selector, keyed by pod name. Returns an error whenever metrics-server is
// unavailable or the query otherwise fails — callers should treat that as "usage data
// not available", not surface it as a hard error to the client.
func fetchPodUsage(ctx context.Context, metricsClient rest.Interface, ns, selector string) (map[string]rawPodMetrics, error) {
	raw, err := metricsClient.Get().
		Namespace(ns).
		Resource("pods").
		Param("labelSelector", selector).
		DoRaw(ctx)
	if err != nil {
		return nil, err
	}
	var list rawPodMetricsList
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	byName := make(map[string]rawPodMetrics, len(list.Items))
	for _, item := range list.Items {
		byName[item.Metadata.Name] = item
	}
	return byName, nil
}

// metricsUsageHandler serves GET /metrics/usage?project_id=&project_slug=&app=&deployment_id=.
// Pod health (ready/restarts) and declared requests/limits always come from the core
// Pods API; live CPU/memory usage additionally requires metrics-server and degrades
// gracefully (usageAvailable: false) when it isn't installed.
//
// deployment_id is optional but, when given, scopes the pod list to the
// app's CURRENT deployment (via the canette.dev/deployment label) — without
// it, a leftover pod from a previous, still-terminating deployment of the
// same app would be listed as if it belonged to the app's current rollout.
func metricsUsageHandler(log *zap.Logger, client kubernetes.Interface, metricsClient rest.Interface) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		projectID := r.URL.Query().Get("project_id")
		projectSlug := r.URL.Query().Get("project_slug")
		app := r.URL.Query().Get("app")
		deploymentID := r.URL.Query().Get("deployment_id")
		if projectID == "" || projectSlug == "" || app == "" {
			http.Error(w, "missing project_id, project_slug or app", http.StatusBadRequest)
			return
		}
		if !projectIDRe.MatchString(projectID) || !projectSlugRe.MatchString(projectSlug) {
			http.Error(w, "invalid project_id or project_slug", http.StatusBadRequest)
			return
		}
		ns := libk8s.AppNamespace(projectID, projectSlug)
		selector := libk8s.AppLabelSelector(app)
		if deploymentID != "" {
			selector = libk8s.AppDeploymentLabelSelector(app, deploymentID)
		}

		pods, err := client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err != nil {
			log.Warn("list pods for metrics failed", zap.Error(err), zap.String("namespace", ns))
			http.Error(w, "list pods failed", http.StatusBadGateway)
			return
		}

		usage, usageErr := fetchPodUsage(ctx, metricsClient, ns, selector)
		if usageErr != nil {
			log.Info("metrics-server unavailable", zap.Error(usageErr))
		}

		resp := usageResponse{UsageAvailable: usageErr == nil, Pods: []podMetrics{}}
		if usageErr != nil {
			resp.UsageUnavailableReason = "metrics-server is not installed or unreachable on this cluster"
		}

		for _, pod := range pods.Items {
			if pod.Status.Phase != corev1.PodRunning && pod.Status.Phase != corev1.PodPending {
				continue
			}
			pm := podMetrics{Name: pod.Name, Ready: podIsReady(&pod), Restarts: podRestartCount(&pod)}
			pm.CPURequestMilli, pm.CPULimitMilli, pm.MemoryRequestBytes, pm.MemoryLimitBytes = podResourceSpec(&pod)
			pm.LastTerminationReason, pm.LastExitCode = podLastTermination(&pod)

			if raw, ok := usage[pod.Name]; ok {
				var cpuMilli, memBytes int64
				for _, c := range raw.Containers {
					if q, err := resource.ParseQuantity(c.Usage.CPU); err == nil {
						cpuMilli += q.MilliValue()
					}
					if q, err := resource.ParseQuantity(c.Usage.Memory); err == nil {
						memBytes += q.Value()
					}
				}
				pm.CPUUsageMilli = &cpuMilli
				pm.MemoryUsageBytes = &memBytes
			}
			resp.Pods = append(resp.Pods, pm)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}

func podIsReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func podRestartCount(pod *corev1.Pod) int32 {
	var total int32
	for _, cs := range pod.Status.ContainerStatuses {
		total += cs.RestartCount
	}
	return total
}

// podLastTermination returns the reason/exit code for the most relevant
// container exit: a currently-Terminated state (e.g. crash-looping between
// restarts) takes priority over the last-known past exit (LastTerminationState),
// which is what's available once the container is Running again after a
// restart — this is what lets the UI show "OOMKilled (exit 137)" even for a
// pod that has since recovered.
func podLastTermination(pod *corev1.Pod) (reason string, exitCode *int32) {
	for _, cs := range pod.Status.ContainerStatuses {
		if t := cs.State.Terminated; t != nil {
			return terminationReason(t), int32Ptr(t.ExitCode)
		}
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if t := cs.LastTerminationState.Terminated; t != nil {
			return terminationReason(t), int32Ptr(t.ExitCode)
		}
	}
	return "", nil
}

func terminationReason(t *corev1.ContainerStateTerminated) string {
	if t.Reason != "" {
		return t.Reason
	}
	return "Error"
}

func int32Ptr(v int32) *int32 { return &v }

func podResourceSpec(pod *corev1.Pod) (cpuReq, cpuLim, memReq, memLim *int64) {
	var cr, cl, mr, ml int64
	var hasCr, hasCl, hasMr, hasMl bool
	for _, c := range pod.Spec.Containers {
		if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cr += q.MilliValue()
			hasCr = true
		}
		if q, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
			cl += q.MilliValue()
			hasCl = true
		}
		if q, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			mr += q.Value()
			hasMr = true
		}
		if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
			ml += q.Value()
			hasMl = true
		}
	}
	if hasCr {
		cpuReq = &cr
	}
	if hasCl {
		cpuLim = &cl
	}
	if hasMr {
		memReq = &mr
	}
	if hasMl {
		memLim = &ml
	}
	return
}
