package k8s

import (
	"context"
	"reflect"
	"testing"
)

func TestWarningCollector(t *testing.T) {
	// No collector in the context: a no-op, not a panic.
	CollectWarning(context.Background(), "ignored")

	ctx, wc := WithWarningCollector(context.Background())
	psa := `would violate PodSecurity "restricted:latest": runAsNonRoot != true`
	CollectWarning(ctx, psa)
	CollectWarning(ctx, psa)
	CollectWarning(ctx, "unrelated deprecation warning")
	CollectWarning(ctx, "")
	if got := wc.PodSecurityWarnings(); !reflect.DeepEqual(got, []string{psa}) {
		t.Errorf("PodSecurityWarnings() = %q, want [%q]", got, psa)
	}
}
