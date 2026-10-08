package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	libk8s "canette.dev/lib/k8s"
)

const (
	defaultTailLines = 100
	maxTailLines     = 1000
	// Caps the bytes read from the kubelet so one pod with very long lines
	// can't blow up the response (and, downstream, an MCP client's context).
	maxTailBytes = 256 * 1024
)

// tailResponse is the GET /logs/tail response. Found is false (with HTTP 200)
// when the app has no pods at all — e.g. never deployed, stopped, or a
// cronjob that hasn't run yet — so callers can tell "nothing to show" apart
// from an upstream failure.
type tailResponse struct {
	Found                 bool   `json:"found"`
	Pod                   string `json:"pod,omitempty"`
	Phase                 string `json:"phase,omitempty"`
	Ready                 bool   `json:"ready"`
	Restarts              int32  `json:"restarts"`
	WaitingReason         string `json:"waitingReason,omitempty"` // e.g. "CrashLoopBackOff", "ImagePullBackOff"
	LastTerminationReason string `json:"lastTerminationReason,omitempty"`
	LastExitCode          *int32 `json:"lastExitCode,omitempty"`
	// Previous is true when Logs come from the previous (crashed) container
	// instance rather than the current one.
	Previous  bool   `json:"previous"`
	Logs      string `json:"logs"`
	LogsError string `json:"logsError,omitempty"`
}

// logsTailHandler serves GET /logs/tail?project_id=&project_slug=&app=&deployment_id=&lines=&previous=.
// Unlike /stream it is a one-shot, non-following read meant for programmatic
// diagnostics (the API's MCP tools): it picks the app's newest pod in any
// phase, returns its status alongside the last N log lines, and — when the
// current container has no logs because it is crash-looping — falls back to
// the previous container instance, which is where the crash output lives.
func logsTailHandler(log *zap.Logger, client kubernetes.Interface) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		projectID := q.Get("project_id")
		projectSlug := q.Get("project_slug")
		app := q.Get("app")
		deploymentID := q.Get("deployment_id")
		if projectID == "" || projectSlug == "" || app == "" {
			http.Error(w, "missing project_id, project_slug or app", http.StatusBadRequest)
			return
		}
		if !projectIDRe.MatchString(projectID) || !projectSlugRe.MatchString(projectSlug) {
			http.Error(w, "invalid project_id or project_slug", http.StatusBadRequest)
			return
		}
		lines := int64(defaultTailLines)
		if v := q.Get("lines"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 1 {
				http.Error(w, "lines must be a positive integer", http.StatusBadRequest)
				return
			}
			lines = min(n, maxTailLines)
		}
		wantPrevious := q.Get("previous") == "true"

		ns := libk8s.AppNamespace(projectID, projectSlug)

		pod, err := newestAppPod(ctx, client, ns, app, deploymentID)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("list pods for log tail failed", zap.Error(err), zap.String("namespace", ns))
			http.Error(w, "list pods failed", http.StatusBadGateway)
			return
		}

		resp := tailResponse{}
		if pod != nil {
			resp = describePod(pod)
			container := appContainerName(pod, app)
			readLogs := func(previous bool) (string, error) {
				limit := int64(maxTailBytes)
				stream, err := client.CoreV1().Pods(ns).GetLogs(pod.Name, &corev1.PodLogOptions{
					Container:  container,
					TailLines:  &lines,
					LimitBytes: &limit,
					Previous:   previous,
				}).Stream(ctx)
				if err != nil {
					return "", err
				}
				defer stream.Close()
				buf, err := io.ReadAll(stream)
				return string(buf), err
			}

			logs, logsErr := readLogs(wantPrevious)
			resp.Previous = wantPrevious
			// A crash-looping container is usually Waiting with no current
			// logs — the useful output is in the previous instance.
			if !wantPrevious && resp.Restarts > 0 && (logsErr != nil || logs == "") {
				if prev, prevErr := readLogs(true); prevErr == nil {
					logs, logsErr, resp.Previous = prev, nil, true
				}
			}
			if ctx.Err() != nil {
				return
			}
			resp.Logs = logs
			if logsErr != nil {
				log.Info("read pod logs failed", zap.Error(logsErr), zap.String("pod", pod.Name))
				resp.LogsError = "could not read logs from the pod (it may not have started yet)"
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}

// newestAppPod returns the most recently created pod for the app, scoped to
// deploymentID when given. If the deployment-scoped lookup finds nothing (e.g.
// the deployment never got as far as creating pods) it falls back to any pod
// of the app. Returns (nil, nil) when the app has no pods.
func newestAppPod(ctx context.Context, client kubernetes.Interface, ns, app, deploymentID string) (*corev1.Pod, error) {
	selectors := []string{libk8s.AppLabelSelector(app)}
	if deploymentID != "" {
		selectors = append([]string{libk8s.AppDeploymentLabelSelector(app, deploymentID)}, selectors...)
	}
	for _, selector := range selectors {
		pods, err := client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err != nil {
			return nil, err
		}
		var newest *corev1.Pod
		for i := range pods.Items {
			p := &pods.Items[i]
			if newest == nil || newest.CreationTimestamp.Before(&p.CreationTimestamp) {
				newest = p
			}
		}
		if newest != nil {
			return newest, nil
		}
	}
	return nil, nil
}

func describePod(pod *corev1.Pod) tailResponse {
	resp := tailResponse{
		Found:    true,
		Pod:      pod.Name,
		Phase:    string(pod.Status.Phase),
		Ready:    podIsReady(pod),
		Restarts: podRestartCount(pod),
	}
	resp.LastTerminationReason, resp.LastExitCode = podLastTermination(pod)
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			resp.WaitingReason = cs.State.Waiting.Reason
			break
		}
	}
	return resp
}

// appContainerName returns the app's own container — the controller names it
// after the app slug — so logs never come from an injected sidecar (authgate).
// Falls back to the first container for pods that don't follow that shape.
func appContainerName(pod *corev1.Pod, app string) string {
	for _, c := range pod.Spec.Containers {
		if c.Name == app {
			return c.Name
		}
	}
	if len(pod.Spec.Containers) > 0 {
		return pod.Spec.Containers[0].Name
	}
	return ""
}
