package k8s

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clienttesting "k8s.io/client-go/testing"

	libk8s "canette.dev/lib/k8s"
)

// appObj is an object of the app with the given id, applied since the app-id
// label exists.
func appObj(apiVersion, kind, name, appID string) *unstructured.Unstructured {
	obj := unstructuredObj(apiVersion, kind, name, map[string]interface{}{})
	obj.SetLabels(map[string]string{libk8s.LabelApp: testApp, libk8s.LabelAppID: appID})
	obj.SetUID(types.UID(kind + "-" + appID))
	return obj
}

// terminating marks obj as being deleted, held back by a finalizer.
func terminating(obj *unstructured.Unstructured) *unstructured.Unstructured {
	now := metav1.Now()
	obj.SetDeletionTimestamp(&now)
	obj.SetFinalizers([]string{"kubernetes.io/pvc-protection"})
	return obj
}

func objectExists(t *testing.T, dyn clienttesting.FakeClient, gvr schema.GroupVersionResource, name string) bool {
	t.Helper()
	_, err := dyn.Tracker().Get(gvr, testNamespace, name)
	if err != nil && !errors.IsNotFound(err) {
		t.Fatal(err)
	}
	return err == nil
}

// Done when (#333): a cleanup of a deleted app that runs late, after a new
// app took the slug, leaves the new app's objects alone.
func TestDeleteApp_RetryAfterSlugReuseLeavesTheNewApp(t *testing.T) {
	newApp := []*unstructured.Unstructured{
		appObj("apps/v1", "Deployment", testApp, "app-2"),
		appObj("v1", "Service", testApp, "app-2"),
		appObj("gateway.networking.k8s.io/v1", "HTTPRoute", testApp, "app-2"),
		appObj("v1", "Secret", secretName(testApp), "app-2"),
		appObj("v1", "ConfigMap", testApp+"-conf-cfg", "app-2"),
		appObj("v1", "PersistentVolumeClaim", testApp+"-data", "app-2"),
		appObj("v1", "Pod", testApp+"-abc12", "app-2"),
	}
	dyn := newFakeDynamic(
		newApp[0], newApp[1], newApp[2], newApp[3], newApp[4], newApp[5], newApp[6],
		// The deleted app's PVC, still there.
		appObj("v1", "PersistentVolumeClaim", testApp+"-old", "app-1"),
	)
	if err := DeleteApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("DeleteApp: %v", err)
	}
	for _, obj := range newApp {
		gvr := map[string]schema.GroupVersionResource{
			"Deployment": gvrDeployment, "Service": gvrService, "HTTPRoute": gvrHTTPRoute,
			"Secret": gvrSecret, "ConfigMap": gvrConfigMap, "PersistentVolumeClaim": gvrPVC, "Pod": gvrPod,
		}[obj.GetKind()]
		if !objectExists(t, dyn, gvr, obj.GetName()) {
			t.Errorf("the new app's %s %s was deleted", obj.GetKind(), obj.GetName())
		}
	}
	if objectExists(t, dyn, gvrPVC, testApp+"-old") {
		t.Error("the deleted app's PVC was kept")
	}
	left, err := RemainingAppObjects(context.Background(), dyn, testNamespace, testOwner)
	if err != nil || len(left) != 0 {
		t.Errorf("remaining = %v, err %v; the new app's objects aren't the deleted app's", left, err)
	}
}

func TestDeleteApp_DeletesWithUIDPrecondition(t *testing.T) {
	dyn := newFakeDynamic(appObj("v1", "Service", testApp, "app-1"))
	if err := DeleteApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("DeleteApp: %v", err)
	}
	var saw bool
	for _, a := range dyn.Actions() {
		del, ok := a.(clienttesting.DeleteAction)
		if !ok || del.GetResource() != gvrService {
			continue
		}
		saw = true
		if p := del.GetDeleteOptions().Preconditions; p == nil || p.UID == nil || *p.UID != "Service-app-1" {
			t.Errorf("delete service: preconditions %v, want the UID read before", p)
		}
	}
	if !saw {
		t.Error("the service was not deleted")
	}
}

func TestRemainingAppObjects_TerminatingPVCAndPods(t *testing.T) {
	dyn := newFakeDynamic(
		terminating(appObj("v1", "PersistentVolumeClaim", testApp+"-data", "app-1")),
		terminating(appObj("v1", "Pod", testApp+"-abc12", "app-1")),
	)
	if err := DeleteApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("DeleteApp: %v", err)
	}
	left, err := RemainingAppObjects(context.Background(), dyn, testNamespace, testOwner)
	if err != nil {
		t.Fatal(err)
	}
	want := map[AppObject]bool{
		{Kind: "PersistentVolumeClaim", Name: testApp + "-data"}: true,
		{Kind: "Pod", Name: testApp + "-abc12"}:                  true,
	}
	if len(left) != len(want) {
		t.Fatalf("remaining = %v, want the terminating PVC and pod", left)
	}
	for _, o := range left {
		if !want[o] {
			t.Errorf("unexpected remaining object %v", o)
		}
	}
}

// A cleanup queued before the app-id label existed matches by slug, but
// never an object that has the label: that one was applied since, possibly
// by a later app that reused the slug.
func TestDeleteApp_LegacyCleanupLeavesLabelledObjects(t *testing.T) {
	legacy := Owner{AppSlug: testApp}
	dyn := newFakeDynamic(
		appObj("v1", "PersistentVolumeClaim", testApp+"-data", "app-2"),
		labelledObj("v1", "PersistentVolumeClaim", testApp+"-old", testApp),
	)
	if err := DeleteApp(context.Background(), dyn, testNamespace, legacy); err != nil {
		t.Fatal(err)
	}
	if !objectExists(t, dyn, gvrPVC, testApp+"-data") {
		t.Error("the later app's PVC was deleted by a legacy cleanup")
	}
	if objectExists(t, dyn, gvrPVC, testApp+"-old") {
		t.Error("the legacy app's own PVC was kept")
	}
}

// Background deletion leaves a Deployment's ReplicaSets and a CronJob's Jobs
// to the garbage collector, and they can still start pods until it is done.
func TestRemainingAppObjects_WaitsForReplicaSetsAndJobs(t *testing.T) {
	dyn := newFakeDynamic(
		appObj("apps/v1", "ReplicaSet", testApp+"-7d9f8", "app-1"),
		appObj("batch/v1", "Job", testApp+"-29123", "app-1"),
	)
	left, err := RemainingAppObjects(context.Background(), dyn, testNamespace, testOwner)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 2 {
		t.Errorf("remaining = %v, want the ReplicaSet and the Job", left)
	}
}

func TestTeardownApp_LeavesAnotherAppsWorkload(t *testing.T) {
	dyn := newFakeDynamic(appObj("apps/v1", "Deployment", testApp, "app-2"))
	if err := TeardownApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatal(err)
	}
	if !objectExists(t, dyn, gvrDeployment, testApp) {
		t.Error("another app's Deployment was torn down")
	}
}

func volumeObj(name, volumeID string) *unstructured.Unstructured {
	obj := unstructuredObj("v1", "PersistentVolumeClaim", name, map[string]interface{}{})
	labels := map[string]string{libk8s.LabelApp: testApp}
	if volumeID != "" {
		labels[libk8s.LabelVolumeID] = volumeID
	}
	obj.SetLabels(labels)
	return obj
}

func TestDeleteVolumeObject(t *testing.T) {
	const pvc = testApp + "-data"
	for _, tc := range []struct {
		name      string
		obj       *unstructured.Unstructured
		volumeID  string
		wantGone  bool
		wantExist bool
	}{
		{"missing", nil, "vol-1", true, false},
		{"its own", volumeObj(pvc, "vol-1"), "vol-1", true, false},
		{"from before the label", volumeObj(pvc, ""), "vol-1", true, false},
		{"queued before the label", volumeObj(pvc, "vol-1"), "", true, false},
		// Re-added under the same name, so it is another volume's now.
		{"another volume's", volumeObj(pvc, "vol-2"), "vol-1", true, true},
		// A pod still mounts it: the row has to stay.
		{"terminating", terminating(volumeObj(pvc, "vol-1")), "vol-1", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dyn := newFakeDynamic()
			if tc.obj != nil {
				dyn = newFakeDynamic(tc.obj)
			}
			gone, err := DeleteVolumeObject(context.Background(), dyn, "PersistentVolumeClaim", testNamespace, pvc, tc.volumeID)
			if err != nil {
				t.Fatal(err)
			}
			if gone != tc.wantGone {
				t.Errorf("gone = %v, want %v", gone, tc.wantGone)
			}
			if got := objectExists(t, dyn, gvrPVC, pvc); got != tc.wantExist {
				t.Errorf("PVC exists = %v, want %v", got, tc.wantExist)
			}
		})
	}
}
