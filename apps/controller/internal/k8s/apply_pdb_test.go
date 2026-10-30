package k8s

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func newFakeDynamic(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	listKinds := map[schema.GroupVersionResource]string{
		gvrConfigMap: "ConfigMapList",
	}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, objs...)
}

func unstructuredObj(apiVersion, kind, name string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata":   map[string]interface{}{"name": name, "namespace": testNamespace},
		"spec":       spec,
	}}
}

func pdbObj() *unstructured.Unstructured {
	return unstructuredObj("policy/v1", "PodDisruptionBudget", testApp, map[string]interface{}{"maxUnavailable": int64(1)})
}

func assertPDBGone(t *testing.T, dyn *dynamicfake.FakeDynamicClient) {
	t.Helper()
	_, err := dyn.Resource(gvrPDB).Namespace(testNamespace).Get(context.Background(), testApp, metav1.GetOptions{})
	if !errors.IsNotFound(err) {
		t.Errorf("expected PDB to be deleted, got err=%v", err)
	}
}

func TestTeardownApp_DeletesPDB(t *testing.T) {
	dyn := newFakeDynamic(pdbObj())
	if err := TeardownApp(context.Background(), dyn, testNamespace, testApp); err != nil {
		t.Fatalf("TeardownApp: %v", err)
	}
	assertPDBGone(t, dyn)
}

func TestTeardownCronJob_DeletesStalePDB(t *testing.T) {
	dyn := newFakeDynamic(pdbObj())
	if err := TeardownCronJob(context.Background(), dyn, testNamespace, testApp); err != nil {
		t.Fatalf("TeardownCronJob: %v", err)
	}
	assertPDBGone(t, dyn)
}

func TestTeardown_NoPDBIsFine(t *testing.T) {
	dyn := newFakeDynamic()
	if err := TeardownApp(context.Background(), dyn, testNamespace, testApp); err != nil {
		t.Fatalf("TeardownApp without PDB: %v", err)
	}
	if err := TeardownCronJob(context.Background(), dyn, testNamespace, testApp); err != nil {
		t.Fatalf("TeardownCronJob without PDB: %v", err)
	}
}

func desiredDeployment(strategy map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"metadata": map[string]interface{}{"name": testApp, "namespace": testNamespace},
		"spec":     map[string]interface{}{"strategy": strategy},
	}
}

func TestClearRollingUpdateForRecreate_RemovesDefaultedRollingUpdate(t *testing.T) {
	live := unstructuredObj("apps/v1", "Deployment", testApp, map[string]interface{}{
		"strategy": map[string]interface{}{
			"type":          "RollingUpdate",
			"rollingUpdate": map[string]interface{}{"maxUnavailable": "25%", "maxSurge": "25%"},
		},
	})
	dyn := newFakeDynamic(live)

	err := clearRollingUpdateForRecreate(context.Background(), dyn, testNamespace,
		desiredDeployment(map[string]interface{}{"type": "Recreate"}))
	if err != nil {
		t.Fatalf("clearRollingUpdateForRecreate: %v", err)
	}

	got, err := dyn.Resource(gvrDeployment).Namespace(testNamespace).Get(context.Background(), testApp, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	if _, found, _ := unstructured.NestedMap(got.Object, "spec", "strategy", "rollingUpdate"); found {
		t.Error("expected rollingUpdate to be removed")
	}
	if typ, _, _ := unstructured.NestedString(got.Object, "spec", "strategy", "type"); typ != "Recreate" {
		t.Errorf("strategy.type = %q, want Recreate", typ)
	}
}

func TestClearRollingUpdateForRecreate_NoopCases(t *testing.T) {
	ctx := context.Background()

	// Deployment doesn't exist yet.
	if err := clearRollingUpdateForRecreate(ctx, newFakeDynamic(), testNamespace,
		desiredDeployment(map[string]interface{}{"type": "Recreate"})); err != nil {
		t.Errorf("missing deployment: %v", err)
	}

	// Desired strategy is RollingUpdate: the live object must not be touched.
	live := unstructuredObj("apps/v1", "Deployment", testApp, map[string]interface{}{
		"strategy": map[string]interface{}{
			"type":          "RollingUpdate",
			"rollingUpdate": map[string]interface{}{"maxUnavailable": "25%"},
		},
	})
	dyn := newFakeDynamic(live)
	if err := clearRollingUpdateForRecreate(ctx, dyn, testNamespace,
		desiredDeployment(map[string]interface{}{"type": "RollingUpdate"})); err != nil {
		t.Fatalf("rolling update desired: %v", err)
	}
	for _, a := range dyn.Actions() {
		if a.GetVerb() == "patch" {
			t.Error("expected no patch when the desired strategy is RollingUpdate")
		}
	}
}
