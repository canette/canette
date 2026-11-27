package k8s

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// Route states in RouteStatus.State.
const (
	// RouteAccepted: the Gateway accepted the current route generation and
	// resolved its backend refs.
	RouteAccepted = "accepted"
	// RouteRejected: the Gateway reports Accepted or ResolvedRefs as False
	// for the current route generation.
	RouteRejected = "rejected"
	// RoutePending: the Gateway hasn't reported on the current generation
	// yet (no status for this Gateway, an older observedGeneration, or a
	// condition that is Unknown).
	RoutePending = "pending"
	// RouteMissing: the HTTPRoute doesn't exist.
	RouteMissing = "missing"
)

// RouteStatus is what the Gateway reports for an app's HTTPRoute.
type RouteStatus struct {
	State string
	// Accepted and ResolvedRefs are the Gateway's conditions for the
	// current generation. A condition reported for an older generation is
	// left out, since it says nothing about the route as it is now.
	Accepted     *RouteCondition
	ResolvedRefs *RouteCondition
}

// RouteCondition is one condition from the route's status.parents entry for
// the Gateway.
type RouteCondition struct {
	Status  string // "True" | "False" | "Unknown"
	Reason  string
	Message string
}

// Problem describes a rejected route's False conditions, e.g.
// "Accepted: NotAllowedByListeners (no listener allows this hostname)".
func (s RouteStatus) Problem() string {
	var parts []string
	for _, c := range []struct {
		typ  string
		cond *RouteCondition
	}{{"Accepted", s.Accepted}, {"ResolvedRefs", s.ResolvedRefs}} {
		if c.cond == nil || c.cond.Status != "False" {
			continue
		}
		p := c.typ + ": " + c.cond.Reason
		if c.cond.Message != "" {
			p += " (" + c.cond.Message + ")"
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, "; ")
}

// CheckRoute reads the app's HTTPRoute name in namespace and what the
// Gateway gwName in gwNamespace reports for its current generation.
func CheckRoute(ctx context.Context, dyn dynamic.Interface, namespace, name, gwName, gwNamespace string) (RouteStatus, error) {
	route, err := dyn.Resource(gvrHTTPRoute).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return RouteStatus{State: RouteMissing}, nil
	}
	if err != nil {
		return RouteStatus{}, fmt.Errorf("get httproute: %w", err)
	}
	return routeStatus(route, gwName, gwNamespace), nil
}

// routeStatus derives the route's state from its status.parents entry for
// the Gateway gwName in gwNamespace.
func routeStatus(route *unstructured.Unstructured, gwName, gwNamespace string) RouteStatus {
	gen := route.GetGeneration()
	s := RouteStatus{State: RoutePending}

	parents, _, _ := unstructured.NestedSlice(route.Object, "status", "parents")
	var conditions []interface{}
	for _, p := range parents {
		parent, ok := p.(map[string]interface{})
		if ok && parentIsGateway(parent, route.GetNamespace(), gwName, gwNamespace) {
			conditions, _, _ = unstructured.NestedSlice(parent, "conditions")
			break
		}
	}
	for _, c := range conditions {
		cond, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if observed, _, _ := unstructured.NestedInt64(cond, "observedGeneration"); observed < gen {
			continue
		}
		typ, _, _ := unstructured.NestedString(cond, "type")
		rc := &RouteCondition{}
		rc.Status, _, _ = unstructured.NestedString(cond, "status")
		rc.Reason, _, _ = unstructured.NestedString(cond, "reason")
		rc.Message, _, _ = unstructured.NestedString(cond, "message")
		switch typ {
		case "Accepted":
			s.Accepted = rc
		case "ResolvedRefs":
			s.ResolvedRefs = rc
		}
	}

	switch {
	case conditionIs(s.Accepted, "False") || conditionIs(s.ResolvedRefs, "False"):
		s.State = RouteRejected
	case conditionIs(s.Accepted, "True") && conditionIs(s.ResolvedRefs, "True"):
		s.State = RouteAccepted
	}
	return s
}

// parentIsGateway reports whether a status.parents entry is for the Gateway
// gwName in gwNamespace. A parentRef without a namespace means the route's
// own, and one without group or kind means a Gateway, as in the Gateway API.
func parentIsGateway(parent map[string]interface{}, routeNamespace, gwName, gwNamespace string) bool {
	ref, ok := parent["parentRef"].(map[string]interface{})
	if !ok {
		return false
	}
	if group, found, _ := unstructured.NestedString(ref, "group"); found && group != "gateway.networking.k8s.io" {
		return false
	}
	if kind, found, _ := unstructured.NestedString(ref, "kind"); found && kind != "Gateway" {
		return false
	}
	name, _, _ := unstructured.NestedString(ref, "name")
	ns, _, _ := unstructured.NestedString(ref, "namespace")
	if ns == "" {
		ns = routeNamespace
	}
	return name == gwName && ns == gwNamespace
}

func conditionIs(c *RouteCondition, status string) bool {
	return c != nil && c.Status == status
}
