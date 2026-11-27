package controller

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"go.uber.org/zap/zaptest"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"canette.dev/controller/internal/store"
	"canette.dev/controller/internal/storetest"
)

// These tests run the cleanup workers against a real Postgres (see
// storetest) and a fake dynamic client, in project p1 ("p").

var (
	testGVRConfigMap = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	testGVRPod       = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
)

type cleanupFixture struct {
	t   *testing.T
	c   *Controller
	db  *sql.DB
	dyn *dynamicfake.FakeDynamicClient
}

func newCleanupFixture(t *testing.T, objs ...runtime.Object) *cleanupFixture {
	t.Helper()
	db := storetest.DB(t)
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			testGVRPVC:       "PersistentVolumeClaimList",
			testGVRConfigMap: "ConfigMapList",
			testGVRPod:       "PodList",
			{Group: "apps", Version: "v1", Resource: "replicasets"}: "ReplicaSetList",
			{Group: "batch", Version: "v1", Resource: "jobs"}:       "JobList",
		}, objs...)
	c := New(store.New(db, zaptest.NewLogger(t)), fake.NewSimpleClientset(), dyn,
		Config{MaxConcurrent: 3}, nil, zaptest.NewLogger(t), nil)
	return &cleanupFixture{t: t, c: c, db: db, dyn: dyn}
}

func (f *cleanupFixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(q, args...); err != nil {
		f.t.Fatal(err)
	}
}

// pvc is a PVC of app slug "gone" in p1's namespace.
func pvc(name, appID, volumeID string, terminating bool) *unstructured.Unstructured {
	labels := map[string]interface{}{"canette.dev/app": "gone", "canette.dev/app-id": appID}
	if volumeID != "" {
		labels["canette.dev/volume-id"] = volumeID
	}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": map[string]interface{}{"name": name, "namespace": appNS, "labels": labels},
	}}
	if terminating {
		now := metav1.Now()
		obj.SetDeletionTimestamp(&now)
		obj.SetFinalizers([]string{"kubernetes.io/pvc-protection"})
	}
	return obj
}

func (f *cleanupFixture) pvcNames() []string {
	f.t.Helper()
	list, err := f.dyn.Resource(testGVRPVC).Namespace(appNS).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, p := range list.Items {
		names = append(names, p.GetName())
	}
	return names
}

// finishTerminating stands in for Kubernetes removing an object once its
// finalizers are done.
func (f *cleanupFixture) finishTerminating(gvr schema.GroupVersionResource, name string) {
	f.t.Helper()
	if err := f.dyn.Tracker().Delete(gvr, appNS, name); err != nil {
		f.t.Fatal(err)
	}
}

// due makes every queued row due for its next attempt.
func (f *cleanupFixture) due(table string) {
	f.exec(`UPDATE ` + table + ` SET next_attempt_at = NULL`)
}

func (f *cleanupFixture) claimAppCleanup() store.PendingAppCleanup {
	f.t.Helper()
	cs, err := f.c.store.ClaimAppCleanups(context.Background(), 10)
	if err != nil || len(cs) != 1 {
		f.t.Fatalf("claimed %v, err %v; want one", cs, err)
	}
	return cs[0]
}

func (f *cleanupFixture) claimVolumeDeletion() store.PendingVolumeDeletion {
	f.t.Helper()
	ds, err := f.c.store.ClaimVolumeDeletions(context.Background(), 10)
	if err != nil || len(ds) != 1 {
		f.t.Fatalf("claimed %v, err %v; want one", ds, err)
	}
	return ds[0]
}

// Done when (#333): a PVC stuck terminating keeps the tombstone, which
// reserves the slug, in place.
func TestCleanupApp_TerminatingPVCKeepsTheTombstone(t *testing.T) {
	f := newCleanupFixture(t, pvc("gone-data", "old-app", "", true))
	f.exec(`INSERT INTO queued_app_cleanups (id, project_id, project_slug, app_slug, app_id, created_at)
		VALUES ('c1', 'p1', 'p', 'gone', 'old-app', CURRENT_TIMESTAMP)`)

	f.c.cleanupApp(context.Background(), f.claimAppCleanup())

	var reason string
	var nextAt, claimedAt sql.NullTime
	if err := f.db.QueryRow(`SELECT COALESCE(pending_reason, ''), next_attempt_at, claimed_at FROM queued_app_cleanups WHERE id = 'c1'`).
		Scan(&reason, &nextAt, &claimedAt); err != nil {
		t.Fatalf("tombstone: %v", err)
	}
	if reason != "waiting for 1 volume to finish shutting down" {
		t.Errorf("pending_reason = %q", reason)
	}
	if !nextAt.Valid || claimedAt.Valid {
		t.Errorf("next_attempt_at %v, claimed_at %v; want a deferred, unclaimed row", nextAt, claimedAt)
	}
	if cs, _ := f.c.store.ClaimAppCleanups(context.Background(), 10); len(cs) != 0 {
		t.Errorf("claimed %v before it was due", cs)
	}

	// The PVC finishes terminating: the next attempt frees the slug.
	f.finishTerminating(testGVRPVC, "gone-data")
	f.due("queued_app_cleanups")
	f.c.cleanupApp(context.Background(), f.claimAppCleanup())
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM queued_app_cleanups`).Scan(&n); err != nil || n != 0 {
		t.Errorf("tombstones left: %d, err %v", n, err)
	}
}

// A worker whose claim expired doesn't finish the claim of the worker that
// took the row over.
func TestCleanupApp_ExpiredClaimCantFreeTheSlug(t *testing.T) {
	f := newCleanupFixture(t, pvc("gone-data", "old-app", "", true))
	f.exec(`INSERT INTO queued_app_cleanups (id, project_id, project_slug, app_slug, app_id, created_at)
		VALUES ('c1', 'p1', 'p', 'gone', 'old-app', CURRENT_TIMESTAMP)`)
	stale := f.claimAppCleanup()
	f.exec(`UPDATE queued_app_cleanups SET claimed_at = $1`, time.Now().Add(-time.Hour))
	f.claimAppCleanup() // another worker takes it over

	if err := f.c.store.MarkAppCleanedUp(context.Background(), stale); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM queued_app_cleanups`).Scan(&n); err != nil || n != 1 {
		t.Errorf("tombstones = %d, err %v; the stale worker removed it", n, err)
	}
}

// Done when (#333): a volume removed and added again under the same name
// ends with exactly one PVC. createVolume names the new volume data-2 while
// the old deletion is queued, and the old PVC terminates on its own.
func TestDeleteVolume_ReaddedVolumeEndsWithOnePVC(t *testing.T) {
	f := newCleanupFixture(t,
		pvc("gone-data", "old-app", "vol-1", true), // a pod still mounts it
		pvc("gone-data-2", "old-app", "vol-2", false),
	)
	f.exec(`INSERT INTO pending_volume_deletions (id, project_id, project_slug, app_slug, volume_name, volume_type, volume_id, created_at)
		VALUES ('d1', 'p1', 'p', 'gone', 'data', 'pvc', 'vol-1', CURRENT_TIMESTAMP)`)

	f.c.deleteVolume(context.Background(), f.claimVolumeDeletion())
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM pending_volume_deletions WHERE next_attempt_at IS NOT NULL AND claimed_at IS NULL`).
		Scan(&n); err != nil || n != 1 {
		t.Fatalf("deferred deletions = %d, err %v; want the row kept while the PVC terminates", n, err)
	}

	f.finishTerminating(testGVRPVC, "gone-data")
	f.due("pending_volume_deletions")
	f.c.deleteVolume(context.Background(), f.claimVolumeDeletion())
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM pending_volume_deletions`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deletions left = %d, err %v", n, err)
	}
	if got := f.pvcNames(); len(got) != 1 || got[0] != "gone-data-2" {
		t.Errorf("PVCs = %v, want only the re-added volume's", got)
	}
}

// A deletion that runs late, after a volume with the same name took the
// object name again, leaves that volume's PVC alone.
func TestDeleteVolume_LateDeletionLeavesTheNewVolume(t *testing.T) {
	f := newCleanupFixture(t, pvc("gone-data", "old-app", "vol-2", false))
	f.exec(`INSERT INTO pending_volume_deletions (id, project_id, project_slug, app_slug, volume_name, volume_type, volume_id, created_at)
		VALUES ('d1', 'p1', 'p', 'gone', 'data', 'pvc', 'vol-1', CURRENT_TIMESTAMP)`)

	f.c.deleteVolume(context.Background(), f.claimVolumeDeletion())
	if got := f.pvcNames(); len(got) != 1 {
		t.Errorf("PVCs = %v, want the new volume's kept", got)
	}
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM pending_volume_deletions`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deletions left = %d, err %v; the removed volume's object is gone", n, err)
	}
}

// A delete Kubernetes refused leaves the namespace active. A retry must
// check its PVCs again, not take the earlier request for a terminating
// namespace, and a blocked namespace no longer holds off a rename back.
func TestCleanupNamespace_RefusedDeleteChecksPVCsAgain(t *testing.T) {
	ns := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]interface{}{"name": "can-p1-old"},
	}}
	f := newCleanupFixture(t, ns)
	refuse := true
	f.dyn.PrependReactor("delete", "namespaces", func(k8stesting.Action) (bool, runtime.Object, error) {
		if refuse {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, "can-p1-old", nil)
		}
		return false, nil, nil
	})
	// Renamed away from "old"; the project still exists.
	f.exec(`INSERT INTO queued_namespace_cleanups (id, project_id, project_slug, created_at)
		VALUES ('q1', 'p1', 'old', CURRENT_TIMESTAMP)`)
	claim := func() store.PendingNamespaceDeletion {
		t.Helper()
		ds, err := f.c.store.ClaimNamespaceDeletions(context.Background(), 10)
		if err != nil || len(ds) != 1 {
			t.Fatalf("claimed %v, err %v", ds, err)
		}
		return ds[0]
	}

	f.c.cleanupNamespace(context.Background(), claim())
	var requested sql.NullTime
	if err := f.db.QueryRow(`SELECT delete_requested_at FROM queued_namespace_cleanups`).Scan(&requested); err != nil || !requested.Valid {
		t.Fatalf("delete_requested_at %v, err %v; the outcome is uncertain, so the rename stays blocked", requested, err)
	}

	// A PVC shows up in the still active namespace before the retry.
	refuse = false
	pvcObj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": map[string]interface{}{"name": "web-data", "namespace": "can-p1-old"},
	}}
	if err := f.dyn.Tracker().Add(pvcObj); err != nil {
		t.Fatal(err)
	}
	f.due("queued_namespace_cleanups")
	f.c.cleanupNamespace(context.Background(), claim())

	if _, err := f.dyn.Resource(testGVRNamespace).Get(context.Background(), "can-p1-old", metav1.GetOptions{}); err != nil {
		t.Fatalf("namespace holding a PVC was deleted on the retry: %v", err)
	}
	var reason string
	if err := f.db.QueryRow(`SELECT COALESCE(blocked_reason, ''), delete_requested_at FROM queued_namespace_cleanups`).
		Scan(&reason, &requested); err != nil {
		t.Fatal(err)
	}
	if reason == "" || requested.Valid {
		t.Errorf("blocked_reason %q, delete_requested_at %v; want blocked, and the rename back allowed again", reason, requested)
	}
}

// A terminating namespace keeps its queued cleanup, which blocks a rename
// back to the slug, until it is gone (#333).
func TestCleanupNamespace_KeepsRowUntilGone(t *testing.T) {
	ns := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]interface{}{"name": "can-p1-old"},
	}}
	f := newCleanupFixture(t, ns)
	// The fake client deletes at once; a real namespace terminates first.
	f.dyn.PrependReactor("delete", "namespaces", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, nil
	})
	f.exec(`INSERT INTO queued_namespace_cleanups (id, project_id, project_slug, created_at)
		VALUES ('q1', 'p1', 'old', CURRENT_TIMESTAMP)`)
	claim := func() store.PendingNamespaceDeletion {
		t.Helper()
		ds, err := f.c.store.ClaimNamespaceDeletions(context.Background(), 10)
		if err != nil || len(ds) != 1 {
			t.Fatalf("claimed %v, err %v", ds, err)
		}
		return ds[0]
	}

	f.c.cleanupNamespace(context.Background(), claim())
	var requested sql.NullTime
	if err := f.db.QueryRow(`SELECT delete_requested_at FROM queued_namespace_cleanups WHERE id = 'q1'`).Scan(&requested); err != nil {
		t.Fatalf("row: %v", err)
	}
	if !requested.Valid {
		t.Error("delete_requested_at not set while the namespace terminates")
	}

	if err := f.dyn.Tracker().Delete(testGVRNamespace, "", "can-p1-old"); err != nil {
		t.Fatal(err)
	}
	f.due("queued_namespace_cleanups")
	d := claim()
	if !d.DeleteRequested {
		t.Error("DeleteRequested not read back")
	}
	f.c.cleanupNamespace(context.Background(), d)
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM queued_namespace_cleanups`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows left = %d, err %v", n, err)
	}
}
