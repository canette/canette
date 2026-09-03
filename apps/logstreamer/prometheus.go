package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"go.uber.org/zap"

	libk8s "canette.dev/lib/k8s"
)

// seriesPoint is a single (timestamp, value) sample in a GET /metrics/timeseries response.
type seriesPoint struct {
	T int64   `json:"t"` // unix seconds
	V float64 `json:"v"`
}

// timeseriesResponse is the GET /metrics/timeseries response body. It degrades
// gracefully (available: false) whenever Prometheus isn't configured or a query
// fails — callers never see an HTTP error for a soft "no time-series data" case,
// mirroring the usageAvailable pattern in metrics.go for metrics-server.
type timeseriesResponse struct {
	Available         bool          `json:"available"`
	UnavailableReason string        `json:"unavailableReason,omitempty"`
	CPUMilli          []seriesPoint `json:"cpuMilli,omitempty"`
	MemoryBytes       []seriesPoint `json:"memoryBytes,omitempty"`
}

// prometheusClient is a thin wrapper around the Prometheus HTTP query API
// (also implemented by Thanos, Mimir, VictoriaMetrics, etc.). A short client
// timeout keeps a slow/hanging Prometheus from blocking the overall response.
type prometheusClient struct {
	baseURL     string
	bearerToken string
	httpClient  *http.Client
}

func newPrometheusClient(baseURL, bearerToken string) *prometheusClient {
	return &prometheusClient{
		baseURL:     baseURL,
		bearerToken: bearerToken,
		httpClient:  &http.Client{Timeout: 5 * time.Second},
	}
}

type promQueryRangeResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Values [][2]interface{} `json:"values"` // [unix_seconds(float64), "value"(string)]
		} `json:"result"`
	} `json:"data"`
}

// queryRange runs a PromQL range query and returns the single-series result
// (canette's queries are always sum(...) aggregates, so at most one series is
// expected). Any non-2xx status, non-"success" body, or decode failure is
// returned as an error — callers treat all of these uniformly as "unavailable".
func (c *prometheusClient) queryRange(ctx context.Context, promql string, start, end time.Time, step time.Duration) ([]seriesPoint, error) {
	q := url.Values{}
	q.Set("query", promql)
	q.Set("start", strconv.FormatInt(start.Unix(), 10))
	q.Set("end", strconv.FormatInt(end.Unix(), 10))
	q.Set("step", strconv.FormatFloat(step.Seconds(), 'f', -1, 64))

	reqURL := c.baseURL + "/api/v1/query_range?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus query_range returned status %d", resp.StatusCode)
	}

	var parsed promQueryRangeResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode prometheus response: %w", err)
	}
	if parsed.Status != "success" {
		return nil, fmt.Errorf("prometheus query_range status %q", parsed.Status)
	}
	if len(parsed.Data.Result) == 0 {
		return []seriesPoint{}, nil
	}

	raw := parsed.Data.Result[0].Values
	points := make([]seriesPoint, 0, len(raw))
	for _, pair := range raw {
		ts, ok := pair[0].(float64)
		if !ok {
			continue
		}
		valStr, ok := pair[1].(string)
		if !ok {
			continue
		}
		val, err := strconv.ParseFloat(valStr, 64)
		if err != nil {
			continue
		}
		points = append(points, seriesPoint{T: int64(ts), V: val})
	}
	return points, nil
}

// podNamePrefixPattern returns a PromQL label-matcher-safe regex matching any
// pod belonging to the given app. The controller always names an app's
// Deployment exactly appSlug (apps/controller/internal/k8s/resources.go), and
// Kubernetes always prefixes generated pod names with the Deployment name, so
// this reliably scopes cAdvisor's namespace-wide metrics (which carry no
// canette.dev labels) down to a single app even when several apps share a
// project namespace.
func podNamePrefixPattern(appSlug string) string {
	return "^" + regexp.QuoteMeta(appSlug) + "-.*$"
}

// cpuQuery builds the PromQL query for an app's aggregate container CPU usage,
// in milli-cores, matching the cpuUsageMilli unit convention from metrics.go.
func cpuQuery(namespace, appSlug string) string {
	return fmt.Sprintf(
		`sum(rate(container_cpu_usage_seconds_total{namespace=%q, pod=~%q, container!="", container!="POD"}[2m])) * 1000`,
		namespace, podNamePrefixPattern(appSlug),
	)
}

// memoryQuery builds the PromQL query for an app's aggregate container memory
// working-set usage, in bytes, matching the memoryUsageBytes unit convention.
func memoryQuery(namespace, appSlug string) string {
	return fmt.Sprintf(
		`sum(container_memory_working_set_bytes{namespace=%q, pod=~%q, container!="", container!="POD"})`,
		namespace, podNamePrefixPattern(appSlug),
	)
}

// timeseriesHandler serves GET /metrics/timeseries?project_id=&project_slug=&app=.
// When promClient is nil (PROMETHEUS_URL unset), it returns available:false
// immediately without attempting a network call.
func timeseriesHandler(log *zap.Logger, promClient *prometheusClient) http.Handler {
	const window = time.Hour
	const step = 60 * time.Second

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

		w.Header().Set("Content-Type", "application/json")

		if promClient == nil {
			_ = json.NewEncoder(w).Encode(timeseriesResponse{
				Available:         false,
				UnavailableReason: "Prometheus is not configured on this cluster",
			})
			return
		}

		ns := libk8s.AppNamespace(projectID, projectSlug)
		ctx := r.Context()
		end := time.Now()
		start := end.Add(-window)

		cpuPoints, cpuErr := promClient.queryRange(ctx, cpuQuery(ns, app), start, end, step)
		if cpuErr != nil {
			log.Info("prometheus cpu query failed", zap.Error(cpuErr))
			_ = json.NewEncoder(w).Encode(timeseriesResponse{
				Available:         false,
				UnavailableReason: "Prometheus is unreachable or the query failed",
			})
			return
		}

		memPoints, memErr := promClient.queryRange(ctx, memoryQuery(ns, app), start, end, step)
		if memErr != nil {
			log.Info("prometheus memory query failed", zap.Error(memErr))
			_ = json.NewEncoder(w).Encode(timeseriesResponse{
				Available:         false,
				UnavailableReason: "Prometheus is unreachable or the query failed",
			})
			return
		}

		_ = json.NewEncoder(w).Encode(timeseriesResponse{
			Available:   true,
			CPUMilli:    cpuPoints,
			MemoryBytes: memPoints,
		})
	})
}
