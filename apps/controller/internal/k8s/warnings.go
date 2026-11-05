package k8s

import (
	"context"
	"strings"
	"sync"
)

// WarningCollector gathers the API server warnings returned while applying
// one deployment's resources, so they can be shown in that deployment's log.
type WarningCollector struct {
	mu       sync.Mutex
	warnings []string
}

type warningCollectorKey struct{}

// WithWarningCollector returns a context whose Kubernetes requests record
// their warnings in the returned collector. Requires the rest.Config to use a
// context-aware warning handler that calls CollectWarning.
func WithWarningCollector(ctx context.Context) (context.Context, *WarningCollector) {
	wc := &WarningCollector{}
	return context.WithValue(ctx, warningCollectorKey{}, wc), wc
}

// CollectWarning records text in the context's collector, if any. Duplicates
// are dropped.
func CollectWarning(ctx context.Context, text string) {
	wc, _ := ctx.Value(warningCollectorKey{}).(*WarningCollector)
	if wc == nil || text == "" {
		return
	}
	wc.mu.Lock()
	defer wc.mu.Unlock()
	for _, w := range wc.warnings {
		if w == text {
			return
		}
	}
	wc.warnings = append(wc.warnings, text)
}

// PodSecurityWarnings returns the collected Pod Security Admission warnings,
// e.g. `would violate PodSecurity "restricted:latest": ...`.
func (wc *WarningCollector) PodSecurityWarnings() []string {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	var out []string
	for _, w := range wc.warnings {
		if strings.Contains(w, "would violate PodSecurity") {
			out = append(out, w)
		}
	}
	return out
}
