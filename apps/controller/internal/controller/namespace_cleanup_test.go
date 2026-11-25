package controller

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"canette.dev/controller/internal/store"
)

var (
	testGVRNamespace = schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}
	testGVRPVC       = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}
)

const queuedNS = "can-01234567-old"

func fakeNamespaceWith(withPVC bool) *dynamicfake.FakeDynamicClient {
	objs := []runtime.Object{&unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]interface{}{"name": queuedNS},
	}}}
	if withPVC {
		objs = append(objs, &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "v1", "kind": "PersistentVolumeClaim",
			"metadata": map[string]interface{}{"name": "web-data", "namespace": queuedNS},
		}})
	}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{testGVRPVC: "PersistentVolumeClaimList"}, objs...)
}

func namespaceExists(t *testing.T, dyn *dynamicfake.FakeDynamicClient) bool {
	t.Helper()
	_, err := dyn.Resource(testGVRNamespace).Get(context.Background(), queuedNS, metav1.GetOptions{})
	if err != nil && !errors.IsNotFound(err) {
		t.Fatal(err)
	}
	return err == nil
}

func TestCleanupQueuedNamespace(t *testing.T) {
	queued := func(projectExists bool) store.PendingNamespaceDeletion {
		return store.PendingNamespaceDeletion{ID: "q1", ProjectID: "0123456789abcdef", ProjectSlug: "old", ProjectExists: projectExists}
	}

	t.Run("renamed project with a PVC is kept", func(t *testing.T) {
		dyn := fakeNamespaceWith(true)
		pvcs, err := cleanupQueuedNamespace(context.Background(), dyn, queued(true))
		if err != nil {
			t.Fatal(err)
		}
		if len(pvcs) != 1 || pvcs[0] != "web-data" {
			t.Errorf("pvcs = %v, want [web-data] so the row stays queued", pvcs)
		}
		if !namespaceExists(t, dyn) {
			t.Error("namespace holding a PVC was deleted")
		}
	})

	t.Run("renamed project without PVCs is deleted", func(t *testing.T) {
		dyn := fakeNamespaceWith(false)
		pvcs, err := cleanupQueuedNamespace(context.Background(), dyn, queued(true))
		if err != nil || len(pvcs) != 0 {
			t.Fatalf("pvcs = %v, err = %v", pvcs, err)
		}
		if namespaceExists(t, dyn) {
			t.Error("namespace was not deleted")
		}
	})

	t.Run("deleted project is deleted even with a PVC", func(t *testing.T) {
		dyn := fakeNamespaceWith(true)
		pvcs, err := cleanupQueuedNamespace(context.Background(), dyn, queued(false))
		if err != nil || len(pvcs) != 0 {
			t.Fatalf("pvcs = %v, err = %v", pvcs, err)
		}
		if namespaceExists(t, dyn) {
			t.Error("namespace was not deleted")
		}
	})
}
