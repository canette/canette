package k8s

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

const routeNS = "can-p1-p"

// condition is one Gateway API condition as it appears in status.parents.
func condition(typ, status, reason string, observedGeneration int64) map[string]interface{} {
	return map[string]interface{}{
		"type": typ, "status": status, "reason": reason, "message": reason + " message",
		"observedGeneration": observedGeneration,
		"lastTransitionTime": "2026-11-27T10:00:00Z",
	}
}

// gatewayParent is a status.parents entry for the Gateway gwName in gwNS.
func gatewayParent(gwName, gwNS string, conditions ...map[string]interface{}) map[string]interface{} {
	conds := make([]interface{}, len(conditions))
	for i, c := range conditions {
		conds[i] = c
	}
	return map[string]interface{}{
		"parentRef": map[string]interface{}{
			"group": "gateway.networking.k8s.io", "kind": "Gateway",
			"name": gwName, "namespace": gwNS,
		},
		"controllerName": "example.com/gateway-controller",
		"conditions":     conds,
	}
}

func httpRoute(generation int64, parents ...map[string]interface{}) *unstructured.Unstructured {
	ps := make([]interface{}, len(parents))
	for i, p := range parents {
		ps[i] = p
	}
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]interface{}{"name": "a", "namespace": routeNS},
		"status":     map[string]interface{}{"parents": ps},
	}}
	u.SetGeneration(generation)
	return u
}

// checkRoute runs CheckRoute against a cluster holding route, or no route
// when nil.
func checkRoute(t *testing.T, route *unstructured.Unstructured) RouteStatus {
	t.Helper()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvrHTTPRoute: "HTTPRouteList"})
	if route != nil {
		if _, err := dyn.Resource(gvrHTTPRoute).Namespace(routeNS).Create(context.Background(), route, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	s, err := CheckRoute(context.Background(), dyn, routeNS, "a", "can-gateway", "kube-system")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCheckRoute_Accepted(t *testing.T) {
	got := checkRoute(t, httpRoute(2, gatewayParent("can-gateway", "kube-system",
		condition("Accepted", "True", "Accepted", 2),
		condition("ResolvedRefs", "True", "ResolvedRefs", 2))))
	if got.State != RouteAccepted || got.Problem() != "" {
		t.Errorf("got %+v, want accepted", got)
	}
}

func TestCheckRoute_Rejected(t *testing.T) {
	got := checkRoute(t, httpRoute(1, gatewayParent("can-gateway", "kube-system",
		condition("Accepted", "False", "NotAllowedByListeners", 1),
		condition("ResolvedRefs", "True", "ResolvedRefs", 1))))
	if got.State != RouteRejected {
		t.Errorf("state = %q, want rejected", got.State)
	}
	if want := "Accepted: NotAllowedByListeners (NotAllowedByListeners message)"; got.Problem() != want {
		t.Errorf("problem = %q, want %q", got.Problem(), want)
	}
}

func TestCheckRoute_UnresolvedBackendRefs(t *testing.T) {
	got := checkRoute(t, httpRoute(1, gatewayParent("can-gateway", "kube-system",
		condition("Accepted", "True", "Accepted", 1),
		condition("ResolvedRefs", "False", "BackendNotFound", 1))))
	if got.State != RouteRejected || got.ResolvedRefs == nil || got.ResolvedRefs.Reason != "BackendNotFound" {
		t.Errorf("got %+v, want rejected with BackendNotFound", got)
	}
}

func TestCheckRoute_Missing(t *testing.T) {
	if got := checkRoute(t, nil); got.State != RouteMissing {
		t.Errorf("state = %q, want missing", got.State)
	}
}

// The Gateway's last report is for generation 1, but the route is now at 2:
// an earlier rejection says nothing about the current spec.
func TestCheckRoute_StatusLagsGeneration(t *testing.T) {
	got := checkRoute(t, httpRoute(2, gatewayParent("can-gateway", "kube-system",
		condition("Accepted", "False", "NotAllowedByListeners", 1),
		condition("ResolvedRefs", "True", "ResolvedRefs", 1))))
	if got.State != RoutePending || got.Accepted != nil || got.ResolvedRefs != nil {
		t.Errorf("got %+v, want pending with no current conditions", got)
	}
}

func TestCheckRoute_NoStatus(t *testing.T) {
	if got := checkRoute(t, httpRoute(1)); got.State != RoutePending {
		t.Errorf("state = %q, want pending", got.State)
	}
}

func TestCheckRoute_ConditionUnknown(t *testing.T) {
	got := checkRoute(t, httpRoute(1, gatewayParent("can-gateway", "kube-system",
		condition("Accepted", "Unknown", "Pending", 1),
		condition("ResolvedRefs", "True", "ResolvedRefs", 1))))
	if got.State != RoutePending {
		t.Errorf("state = %q, want pending", got.State)
	}
}

// Only the configured Gateway's entry counts: another Gateway accepting the
// route doesn't route the app's URL.
func TestCheckRoute_OtherGatewayIgnored(t *testing.T) {
	got := checkRoute(t, httpRoute(1,
		gatewayParent("other-gateway", "kube-system",
			condition("Accepted", "True", "Accepted", 1),
			condition("ResolvedRefs", "True", "ResolvedRefs", 1)),
		gatewayParent("can-gateway", "kube-system",
			condition("Accepted", "False", "NoMatchingParent", 1))))
	if got.State != RouteRejected || got.Accepted.Reason != "NoMatchingParent" {
		t.Errorf("got %+v, want the configured Gateway's rejection", got)
	}
}

// A parentRef without a namespace means the route's own namespace, so it
// isn't the Gateway in kube-system.
func TestParentIsGateway_DefaultsNamespace(t *testing.T) {
	parent := map[string]interface{}{"parentRef": map[string]interface{}{"name": "can-gateway"}}
	if parentIsGateway(parent, routeNS, "can-gateway", "kube-system") {
		t.Error("matched a parentRef in the route's namespace")
	}
	if !parentIsGateway(parent, "kube-system", "can-gateway", "kube-system") {
		t.Error("didn't match a parentRef in the Gateway's namespace")
	}
}
