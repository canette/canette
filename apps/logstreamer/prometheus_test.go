package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestQueryRange_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization header = %q, want Bearer test-token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "matrix",
				"result": [
					{"metric": {}, "values": [[1000, "1.5"], [1060, "2.25"]]}
				]
			}
		}`))
	}))
	defer srv.Close()

	c := newPrometheusClient(srv.URL, "test-token")
	points, err := c.queryRange(context.Background(), "up", time.Unix(1000, 0), time.Unix(1060, 0), 60*time.Second)
	if err != nil {
		t.Fatalf("queryRange() error = %v", err)
	}
	if len(points) != 2 {
		t.Fatalf("len(points) = %d, want 2", len(points))
	}
	if points[0].T != 1000 || points[0].V != 1.5 {
		t.Errorf("points[0] = %+v, want {T:1000 V:1.5}", points[0])
	}
	if points[1].T != 1060 || points[1].V != 2.25 {
		t.Errorf("points[1] = %+v, want {T:1060 V:2.25}", points[1])
	}
}

func TestQueryRange_EmptyResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status": "success", "data": {"resultType": "matrix", "result": []}}`))
	}))
	defer srv.Close()

	c := newPrometheusClient(srv.URL, "")
	points, err := c.queryRange(context.Background(), "up", time.Unix(0, 0), time.Unix(60, 0), 60*time.Second)
	if err != nil {
		t.Fatalf("queryRange() error = %v", err)
	}
	if len(points) != 0 {
		t.Errorf("len(points) = %d, want 0", len(points))
	}
}

func TestQueryRange_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()

	c := newPrometheusClient(srv.URL, "")
	if _, err := c.queryRange(context.Background(), "up", time.Unix(0, 0), time.Unix(60, 0), 60*time.Second); err == nil {
		t.Fatal("queryRange() error = nil, want error for malformed JSON")
	}
}

func TestQueryRange_NonSuccessStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status": "error", "data": {}}`))
	}))
	defer srv.Close()

	c := newPrometheusClient(srv.URL, "")
	if _, err := c.queryRange(context.Background(), "up", time.Unix(0, 0), time.Unix(60, 0), 60*time.Second); err == nil {
		t.Fatal("queryRange() error = nil, want error for status != success")
	}
}

func TestQueryRange_NonOKHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newPrometheusClient(srv.URL, "")
	if _, err := c.queryRange(context.Background(), "up", time.Unix(0, 0), time.Unix(60, 0), 60*time.Second); err == nil {
		t.Fatal("queryRange() error = nil, want error for non-200 status")
	}
}

func TestCPUQuery_InterpolatesNamespaceAndPodPattern(t *testing.T) {
	got := cpuQuery("can-abc1234-myproj", "my-app")
	if !strings.Contains(got, `namespace="can-abc1234-myproj"`) {
		t.Errorf("cpuQuery() = %q, missing expected namespace matcher", got)
	}
	if !strings.Contains(got, `pod=~"^my-app-.*$"`) {
		t.Errorf("cpuQuery() = %q, missing expected pod matcher", got)
	}
}

func TestMemoryQuery_InterpolatesNamespaceAndPodPattern(t *testing.T) {
	got := memoryQuery("can-abc1234-myproj", "my-app")
	if !strings.Contains(got, `namespace="can-abc1234-myproj"`) {
		t.Errorf("memoryQuery() = %q, missing expected namespace matcher", got)
	}
	if !strings.Contains(got, `pod=~"^my-app-.*$"`) {
		t.Errorf("memoryQuery() = %q, missing expected pod matcher", got)
	}
}

// TestPodNamePrefixPattern_EscapesRegexMetacharacters guards against PromQL
// label-selector injection via an app slug containing regex metacharacters —
// app slugs are validated elsewhere (lowercase alphanumeric + hyphens), but
// this is a defense-in-depth check that the pattern is always quoted safely.
func TestPodNamePrefixPattern_EscapesRegexMetacharacters(t *testing.T) {
	got := podNamePrefixPattern(`evil".*}or{1=1`)
	if strings.Contains(got, `".*}`) {
		t.Errorf("podNamePrefixPattern() = %q, regex metacharacters not escaped", got)
	}
}

func TestTimeseriesHandler_NoPrometheusConfigured(t *testing.T) {
	h := timeseriesHandler(zap.NewNop(), nil)
	req := httptest.NewRequest(http.MethodGet, "/metrics/timeseries?project_id=17e4422a-1234-5678-abcd-ef0123456789&project_slug=my-project&app=my-app", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Errorf("body = %s, want available:false", rec.Body.String())
	}
}

func TestTimeseriesHandler_MissingParams(t *testing.T) {
	h := timeseriesHandler(zap.NewNop(), nil)
	req := httptest.NewRequest(http.MethodGet, "/metrics/timeseries", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestTimeseriesHandler_QueryFailureDegradesGracefully(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := timeseriesHandler(zap.NewNop(), newPrometheusClient(srv.URL, ""))
	req := httptest.NewRequest(http.MethodGet, "/metrics/timeseries?project_id=17e4422a-1234-5678-abcd-ef0123456789&project_slug=my-project&app=my-app", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (soft degrade, not an HTTP error)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Errorf("body = %s, want available:false", rec.Body.String())
	}
}
