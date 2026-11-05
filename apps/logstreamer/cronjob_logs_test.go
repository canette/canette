package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	libk8s "canette.dev/lib/k8s"
)

type countingReader struct {
	io.Reader
	bytesRead int
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.bytesRead += n
	return n, err
}

func TestWriteBoundedLogEvent_PreservesOrdinaryLog(t *testing.T) {
	input := "first\r\nsecond\n"
	var got bytes.Buffer

	truncated, err := writeBoundedLogEvent(&got, strings.NewReader(input), 1024)
	if err != nil {
		t.Fatalf("writeBoundedLogEvent: %v", err)
	}
	if truncated {
		t.Fatal("truncated = true, want false")
	}
	if want := formatLogEvent([]byte(input)); got.String() != want {
		t.Fatalf("event = %q, want %q", got.String(), want)
	}
}

func TestWriteBoundedLogEvent_ExactLimitIsNotTruncated(t *testing.T) {
	input := "12345678"
	src := &countingReader{Reader: strings.NewReader(input)}
	var got bytes.Buffer

	truncated, err := writeBoundedLogEvent(&got, src, int64(len(input)))
	if err != nil {
		t.Fatalf("writeBoundedLogEvent: %v", err)
	}
	if truncated {
		t.Fatal("truncated = true, want false")
	}
	if want := formatLogEvent([]byte(input)); got.String() != want {
		t.Fatalf("event = %q, want %q", got.String(), want)
	}
	if src.bytesRead != len(input) {
		t.Fatalf("source bytes read = %d, want %d", src.bytesRead, len(input))
	}
}

func TestWriteBoundedLogEvent_CapsOversizedInputs(t *testing.T) {
	tests := []struct {
		name  string
		input string
		limit int64
	}{
		{name: "single oversized line", input: strings.Repeat("x", 64), limit: 8},
		{name: "many short lines", input: strings.Repeat("x\n", 32), limit: 9},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := &countingReader{Reader: strings.NewReader(tt.input)}
			var got bytes.Buffer

			truncated, err := writeBoundedLogEvent(&got, src, tt.limit)
			if err != nil {
				t.Fatalf("writeBoundedLogEvent: %v", err)
			}
			if !truncated {
				t.Fatal("truncated = false, want true")
			}
			if want := formatLogEvent([]byte(tt.input[:tt.limit])); got.String() != want {
				t.Fatalf("event = %q, want %q", got.String(), want)
			}
			if want := int(tt.limit + 1); src.bytesRead != want {
				t.Fatalf("source bytes read = %d, want %d", src.bytesRead, want)
			}
		})
	}
}

func TestHandleCronJobLogs_RequestsAndEnforcesByteLimit(t *testing.T) {
	labels := map[string]string{libk8s.LabelApp: testApp}
	pod := testPod("web-complete", time.Now(), labels, corev1.PodStatus{Phase: corev1.PodSucceeded})
	client := fake.NewClientset(pod)
	var options *corev1.PodLogOptions
	client.PrependReactor("get", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "log" {
			return false, nil, nil
		}
		generic, ok := action.(k8stesting.GenericAction)
		if !ok {
			t.Fatalf("log action type = %T, want testing.GenericAction", action)
		}
		options, ok = generic.GetValue().(*corev1.PodLogOptions)
		if !ok {
			t.Fatalf("log options type = %T, want *corev1.PodLogOptions", generic.GetValue())
		}
		// Deliberately ignore LimitBytes to exercise the local enforcement boundary.
		return true, &runtime.Unknown{Raw: bytes.Repeat([]byte("Z"), maxOneShotLogBytes+2)}, nil
	})

	req := httptest.NewRequest("GET", "/logs/stream?type=cronjob", nil)
	rec := httptest.NewRecorder()
	handleCronJobLogs(rec, req, zap.NewNop(), client, pod.Namespace, testApp)

	if options == nil || options.LimitBytes == nil {
		t.Fatal("PodLogOptions.LimitBytes is nil")
	}
	if want := int64(maxOneShotLogBytes + 1); *options.LimitBytes != want {
		t.Fatalf("PodLogOptions.LimitBytes = %d, want %d", *options.LimitBytes, want)
	}
	if options.Follow {
		t.Fatal("PodLogOptions.Follow = true, want false")
	}
	if got := bytes.Count(rec.Body.Bytes(), []byte("Z")); got != maxOneShotLogBytes {
		t.Fatalf("returned log bytes = %d, want %d", got, maxOneShotLogBytes)
	}
	wantMarker := fmt.Sprintf("event: truncated\ndata: {\"limitBytes\":%d}\n\n", maxOneShotLogBytes)
	if !strings.Contains(rec.Body.String(), wantMarker) {
		t.Fatalf("response missing truncation marker %q", wantMarker)
	}
}
