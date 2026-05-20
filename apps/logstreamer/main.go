package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	libk8s "canette.dev/lib/k8s"
	"canette.dev/lib/env"
)

func main() {
	logLevel := os.Getenv("LOG_LEVEL")
	zapCfg := zap.NewProductionConfig()
	if err := zapCfg.Level.UnmarshalText([]byte(logLevel)); err != nil {
		zapCfg.Level.SetLevel(zap.InfoLevel)
	}
	log, _ := zapCfg.Build()
	defer func() { _ = log.Sync() }()

	log.Info("canette logstreamer starting")

	if err := run(log); err != nil {
		log.Fatal("logstreamer error", zap.Error(err))
	}
}

func run(log *zap.Logger) error {
	// .env file for local dev
	if _, err := os.Stat(".env"); err == nil {
		_ = godotenv.Load()
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	restCfg, err := loadKubeConfig()
	if err != nil {
		return fmt.Errorf("load kubeconfig: %w", err)
	}

	k8sClient, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	secret := os.Getenv("LOGSTREAMER_SECRET")
	if secret == "" {
		return fmt.Errorf("LOGSTREAMER_SECRET environment variable is required")
	}

	addr := env.EnvOr("ADDR", ":8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           newMux(log, k8sClient, secret),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Info("logstreamer listening", zap.String("addr", addr))
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func newMux(log *zap.Logger, client kubernetes.Interface, secret string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /stream", requireSecret(secret, streamHandler(log, client)))
	return mux
}

// requireSecret is a middleware that validates the Authorization: Bearer <token> header
// using constant-time comparison to prevent timing attacks.
func requireSecret(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(token), []byte(secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// runMeta is sent as the first SSE event for CronJob log streams.
type runMeta struct {
	Status     string `json:"status"`               // "succeeded" | "failed" | "no_runs"
	StartedAt  string `json:"startedAt,omitempty"`  // RFC3339
	FinishedAt string `json:"finishedAt,omitempty"` // RFC3339
}

var (
	projectIDRe   = regexp.MustCompile(`^[0-9a-f-]{36}$`)
	projectSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
)

func streamHandler(log *zap.Logger, client kubernetes.Interface) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		projectID := r.URL.Query().Get("project_id")
		projectSlug := r.URL.Query().Get("project_slug")
		app := r.URL.Query().Get("app")
		if projectID == "" || projectSlug == "" || app == "" {
			http.Error(w, "missing project_id, project_slug or app", http.StatusBadRequest)
			return
		}
		if !projectIDRe.MatchString(projectID) || !projectSlugRe.MatchString(projectSlug) {
			http.Error(w, "invalid project_id or project_slug", http.StatusBadRequest)
			return
		}
		ns := libk8s.AppNamespace(projectID, projectSlug)

		if r.URL.Query().Get("type") == "cronjob" {
			handleCronJobLogs(w, r, log, client, ns, app)
			return
		}

		ctx := r.Context()

		log.Info("logs requested", zap.String("namespace", ns), zap.String("app", app))

		podName, err := waitForRunningPod(ctx, client, ns, app, log)
		if err != nil {
			// context cancelled — client disconnected before a pod was found
			return
		}
		if podName == "" {
			log.Warn("no running pod", zap.String("namespace", ns), zap.String("app", app))
			http.Error(w, "no running pod", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")

		logTail := int64(10)

		req := client.CoreV1().Pods(ns).GetLogs(podName, &corev1.PodLogOptions{
			TailLines: &logTail,
			Follow:    true,
		})
		stream, err := req.Stream(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("open log stream failed", zap.Error(err), zap.String("pod", podName))
			http.Error(w, "stream error", http.StatusInternalServerError)
			return
		}
		defer stream.Close()

		log.Info("streaming logs", zap.String("namespace", ns), zap.String("pod", podName))

		flusher, canFlush := w.(http.Flusher)

		// Read from the K8s log stream in a goroutine so we can interleave
		// keep-alive pings via a ticker without blocking on Read.
		dataCh := make(chan []byte, 8)
		go func() {
			defer close(dataCh)
			buf := make([]byte, 4096)
			for {
				n, err := stream.Read(buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					select {
					case dataCh <- chunk:
					case <-ctx.Done():
						return
					}
				}
				if err != nil {
					return
				}
			}
		}()

		// All writes happen here (single goroutine) — no mutex needed.
		// Log chunks are formatted as named SSE events; pings are named SSE
		// events that keep both the upstream fetch and the browser connection alive.
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case chunk, ok := <-dataCh:
				if !ok {
					return
				}
				_, _ = fmt.Fprint(w, formatLogEvent(chunk))
				if canFlush {
					flusher.Flush()
				}
			case <-ticker.C:
				_, _ = fmt.Fprint(w, "event: ping\ndata: \n\n")
				if canFlush {
					flusher.Flush()
				}
			case <-ctx.Done():
				return
			}
		}
	})
}

// handleCronJobLogs writes a one-shot SSE response: first a "meta" event with the
// last run's status and timestamps, then "log" events for each line of pod output.
// The connection closes after the full log is written (no follow).
func handleCronJobLogs(w http.ResponseWriter, r *http.Request, log *zap.Logger, client kubernetes.Interface, ns, appSlug string) {
	ctx := r.Context()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, canFlush := w.(http.Flusher)

	pod, err := latestCompletedPod(ctx, client, ns, appSlug)
	if err != nil {
		// context cancelled — client disconnected
		return
	}

	if pod == nil {
		meta, _ := json.Marshal(runMeta{Status: "no_runs"})
		fmt.Fprintf(w, "event: meta\ndata: %s\n\n", meta)
		if canFlush {
			flusher.Flush()
		}
		return
	}

	log.Info("cronjob logs requested", zap.String("namespace", ns), zap.String("pod", pod.Name))

	meta := runMeta{Status: "succeeded"}
	if pod.Status.Phase == corev1.PodFailed {
		meta.Status = "failed"
	}
	if pod.Status.StartTime != nil {
		meta.StartedAt = pod.Status.StartTime.UTC().Format(time.RFC3339)
	}
	if t := podFinishedAt(pod); !t.IsZero() {
		meta.FinishedAt = t.UTC().Format(time.RFC3339)
	}
	metaJSON, _ := json.Marshal(meta)
	fmt.Fprintf(w, "event: meta\ndata: %s\n\n", metaJSON)
	if canFlush {
		flusher.Flush()
	}

	req := client.CoreV1().Pods(ns).GetLogs(pod.Name, &corev1.PodLogOptions{Follow: false})
	stream, err := req.Stream(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("open cronjob pod log stream failed", zap.Error(err), zap.String("pod", pod.Name))
		return
	}
	defer stream.Close()

	buf, err := io.ReadAll(stream)
	if err != nil && ctx.Err() != nil {
		return
	}
	if len(buf) > 0 {
		_, _ = fmt.Fprint(w, formatLogEvent(buf))
		if canFlush {
			flusher.Flush()
		}
	}
}

// latestCompletedPod returns the most recently finished pod (Succeeded or Failed)
// for the given app. Returns (nil, nil) when no completed pod exists.
// Returns (nil, err) only on context cancellation.
func latestCompletedPod(ctx context.Context, client kubernetes.Interface, ns, appSlug string) (*corev1.Pod, error) {
	pods, err := client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nil
	}

	var latest *corev1.Pod
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
			continue
		}
		if latest == nil || podFinishedAt(pod).After(podFinishedAt(latest)) {
			latest = pod
		}
	}
	return latest, nil
}

// podFinishedAt returns the finished-at timestamp from the first terminated container,
// falling back to the zero time if no such status exists.
func podFinishedAt(pod *corev1.Pod) time.Time {
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Terminated != nil {
			return cs.State.Terminated.FinishedAt.Time
		}
	}
	return time.Time{}
}

// waitForRunningPod polls for up to 5 s for a Running pod with the given app label.
// Returns ("", nil) when no pod is found after the deadline.
// Returns ("", err) only on context cancellation.
func waitForRunningPod(ctx context.Context, client kubernetes.Interface, ns, appSlug string, log *zap.Logger) (string, error) {
	const retryDuration = 5 * time.Second
	const pollInterval = 500 * time.Millisecond

	deadline := time.Now().Add(retryDuration)
	selector := libk8s.AppLabelSelector(appSlug)

	for {
		pods, err := client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
			LabelSelector: selector,
		})
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			log.Warn("list pods failed", zap.Error(err))
		} else {
			for _, pod := range pods.Items {
				if pod.Status.Phase == corev1.PodRunning {
					return pod.Name, nil
				}
			}
		}

		if time.Now().After(deadline) {
			return "", nil
		}

		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// formatLogEvent formats a raw chunk from the K8s log stream as an SSE event.
// Each line in the chunk becomes a "data: <line>" field, and the event ends
// with a blank line so the browser dispatches it as a single "log" event.
func formatLogEvent(chunk []byte) string {
	lines := strings.Split(strings.TrimRight(string(chunk), "\n"), "\n")
	var sb strings.Builder
	sb.WriteString("event: log\n")
	for _, line := range lines {
		sb.WriteString("data: ")
		sb.WriteString(strings.ReplaceAll(line, "\r", ""))
		sb.WriteString("\n")
	}
	sb.WriteString("\n")
	return sb.String()
}

func loadKubeConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	kubeconfig := env.EnvOr("KUBECONFIG", clientcmd.RecommendedHomeFile)
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}

