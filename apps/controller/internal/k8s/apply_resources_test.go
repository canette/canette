package k8s

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	libk8s "canette.dev/lib/k8s"
)

func newFakeDynamic(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	listKinds := map[schema.GroupVersionResource]string{
		gvrConfigMap:  "ConfigMapList",
		gvrPVC:        "PersistentVolumeClaimList",
		gvrPod:        "PodList",
		gvrReplicaSet: "ReplicaSetList",
		gvrJob:        "JobList",
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

// testOwner is the app the teardown and cleanup tests delete. Fixtures
// labelled only with its slug stand for objects applied before the app-id
// label existed.
var testOwner = Owner{AppID: "app-1", AppSlug: testApp}

func pdbObj() *unstructured.Unstructured {
	obj := unstructuredObj("policy/v1", "PodDisruptionBudget", testApp, map[string]interface{}{"maxUnavailable": int64(1)})
	obj.SetLabels(map[string]string{libk8s.LabelApp: testApp})
	return obj
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
	if err := TeardownApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownApp: %v", err)
	}
	assertPDBGone(t, dyn)
}

func TestTeardownCronJob_DeletesStalePDB(t *testing.T) {
	dyn := newFakeDynamic(pdbObj())
	if err := TeardownCronJob(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownCronJob: %v", err)
	}
	assertPDBGone(t, dyn)
}

func TestTeardown_NoPDBIsFine(t *testing.T) {
	dyn := newFakeDynamic()
	if err := TeardownApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownApp without PDB: %v", err)
	}
	if err := TeardownCronJob(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownCronJob without PDB: %v", err)
	}
}

func labelledObj(apiVersion, kind, name, appSlug string) *unstructured.Unstructured {
	obj := unstructuredObj(apiVersion, kind, name, map[string]interface{}{})
	obj.SetLabels(map[string]string{libk8s.LabelApp: appSlug})
	return obj
}

func TestDeleteApp_RemovesEverythingTheAppOwned(t *testing.T) {
	dyn := newFakeDynamic(
		labelledObj("apps/v1", "Deployment", testApp, testApp),
		labelledObj("v1", "Service", testApp, testApp),
		labelledObj("gateway.networking.k8s.io/v1", "HTTPRoute", testApp, testApp),
		labelledObj("batch/v1", "CronJob", testApp, testApp),
		pdbObj(),
		labelledObj("v1", "Secret", secretName(testApp), testApp),
		labelledObj("v1", "Secret", authgateSecretName(testApp), testApp),
		labelledObj("v1", "ConfigMap", testApp+"-conf-cfg", testApp),
		labelledObj("v1", "PersistentVolumeClaim", testApp+"-data", testApp),
		// Removed from canette earlier, its own deletion never ran.
		labelledObj("v1", "PersistentVolumeClaim", testApp+"-old", testApp),
		// Shared by every app in the namespace, labelled by the last one to apply it.
		labelledObj("v1", "Secret", "canette-registry-creds", testApp),
		labelledObj("v1", "PersistentVolumeClaim", "other-app-data", "other-app"),
	)
	if err := DeleteApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("DeleteApp: %v", err)
	}

	gone := []struct {
		gvr  schema.GroupVersionResource
		name string
	}{
		{gvrDeployment, testApp},
		{gvrService, testApp},
		{gvrHTTPRoute, testApp},
		{gvrCronJob, testApp},
		{gvrPDB, testApp},
		{gvrSecret, secretName(testApp)},
		{gvrSecret, authgateSecretName(testApp)},
		{gvrConfigMap, testApp + "-conf-cfg"},
		{gvrPVC, testApp + "-data"},
		{gvrPVC, testApp + "-old"},
	}
	for _, g := range gone {
		if _, err := dyn.Resource(g.gvr).Namespace(testNamespace).Get(context.Background(), g.name, metav1.GetOptions{}); !errors.IsNotFound(err) {
			t.Errorf("expected %s/%s to be deleted, got err=%v", g.gvr.Resource, g.name, err)
		}
	}

	kept := []struct {
		gvr  schema.GroupVersionResource
		name string
	}{
		{gvrSecret, "canette-registry-creds"},
		{gvrPVC, "other-app-data"},
	}
	for _, k := range kept {
		if _, err := dyn.Resource(k.gvr).Namespace(testNamespace).Get(context.Background(), k.name, metav1.GetOptions{}); err != nil {
			t.Errorf("expected %s/%s to be kept, got err=%v", k.gvr.Resource, k.name, err)
		}
	}
}

func TestDeleteApp_NothingLeftIsFine(t *testing.T) {
	if err := DeleteApp(context.Background(), newFakeDynamic(), testNamespace, testOwner); err != nil {
		t.Fatalf("DeleteApp on an empty namespace: %v", err)
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

func pvcObj(storageClass string) *unstructured.Unstructured {
	spec := map[string]interface{}{"accessModes": []interface{}{"ReadWriteOnce"}}
	if storageClass != "" {
		spec["storageClassName"] = storageClass
	}
	return unstructuredObj("v1", "PersistentVolumeClaim", "my-app-data", spec)
}

func desiredPVC(storageClass string) map[string]interface{} {
	return pvcObj(storageClass).Object
}

func TestKeepLiveStorageClass_NewPVCUnchanged(t *testing.T) {
	desired := desiredPVC("fast-ssd")
	got, err := keepLiveStorageClass(context.Background(), newFakeDynamic(), testNamespace, desired)
	if err != nil {
		t.Fatal(err)
	}
	if class, _, _ := unstructured.NestedString(got, "spec", "storageClassName"); class != "fast-ssd" {
		t.Errorf("storageClassName = %q, want fast-ssd", class)
	}
}

func TestKeepLiveStorageClass_ExistingPVCKeepsItsClass(t *testing.T) {
	dyn := newFakeDynamic(pvcObj("standard"))
	desired := desiredPVC("fast-ssd")
	got, err := keepLiveStorageClass(context.Background(), dyn, testNamespace, desired)
	if err != nil {
		t.Fatal(err)
	}
	if class, _, _ := unstructured.NestedString(got, "spec", "storageClassName"); class != "standard" {
		t.Errorf("storageClassName = %q, want the live value standard", class)
	}
	// The caller's object must not be modified.
	if class, _, _ := unstructured.NestedString(desired, "spec", "storageClassName"); class != "fast-ssd" {
		t.Errorf("desired PVC was mutated: storageClassName = %q", class)
	}
}

func TestKeepLiveStorageClass_ExistingPVCWithoutClass(t *testing.T) {
	dyn := newFakeDynamic(pvcObj(""))
	got, err := keepLiveStorageClass(context.Background(), dyn, testNamespace, desiredPVC("fast-ssd"))
	if err != nil {
		t.Fatal(err)
	}
	if _, found, _ := unstructured.NestedString(got, "spec", "storageClassName"); found {
		t.Error("expected storageClassName to be left out when the live PVC has none")
	}
}

func TestApplyOrDelete_DeletesWhenNil(t *testing.T) {
	quota := unstructuredObj("v1", "ResourceQuota", resourceQuotaName, map[string]interface{}{})
	dyn := newFakeDynamic(quota)
	if err := applyOrDelete(context.Background(), dyn, gvrResourceQuota, testNamespace, resourceQuotaName, nil); err != nil {
		t.Fatal(err)
	}
	_, err := dyn.Resource(gvrResourceQuota).Namespace(testNamespace).Get(context.Background(), resourceQuotaName, metav1.GetOptions{})
	if !errors.IsNotFound(err) {
		t.Errorf("expected stale quota to be deleted, got err=%v", err)
	}
	// Nothing to delete is fine too.
	if err := applyOrDelete(context.Background(), dyn, gvrLimitRange, testNamespace, limitRangeName, nil); err != nil {
		t.Errorf("deleting a missing LimitRange: %v", err)
	}
}

func quotaObj(used map[string]interface{}) *unstructured.Unstructured {
	q := unstructuredObj("v1", "ResourceQuota", resourceQuotaName, map[string]interface{}{
		"hard": map[string]interface{}{"requests.cpu": "4", "persistentvolumeclaims": "10"},
	})
	if used != nil {
		q.Object["status"] = map[string]interface{}{"used": used}
	}
	return q
}

func shortQuotaWait(t *testing.T) {
	t.Helper()
	timeout, interval := quotaUsageTimeout, quotaUsageInterval
	quotaUsageTimeout, quotaUsageInterval = 50*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { quotaUsageTimeout, quotaUsageInterval = timeout, interval })
}

func TestWaitForQuotaUsage_ReturnsWhenUsageKnown(t *testing.T) {
	shortQuotaWait(t)
	dyn := newFakeDynamic(quotaObj(map[string]interface{}{"requests.cpu": "0", "persistentvolumeclaims": "0"}))
	start := time.Now()
	if err := waitForQuotaUsage(context.Background(), dyn, testNamespace, resourceQuotaName); err != nil {
		t.Fatalf("waitForQuotaUsage: %v", err)
	}
	if time.Since(start) >= quotaUsageTimeout {
		t.Error("expected an immediate return when usage is already known")
	}
}

func TestWaitForQuotaUsage_TimeoutIsNotAnError(t *testing.T) {
	shortQuotaWait(t)
	// Usage known for only one of the two resources.
	dyn := newFakeDynamic(quotaObj(map[string]interface{}{"requests.cpu": "0"}))
	start := time.Now()
	if err := waitForQuotaUsage(context.Background(), dyn, testNamespace, resourceQuotaName); err != nil {
		t.Fatalf("expected nil on timeout, got %v", err)
	}
	if time.Since(start) < quotaUsageTimeout {
		t.Error("expected to wait until the timeout while usage is incomplete")
	}
}

func TestWaitForQuotaUsage_MissingQuotaIsAnError(t *testing.T) {
	shortQuotaWait(t)
	if err := waitForQuotaUsage(context.Background(), newFakeDynamic(), testNamespace, resourceQuotaName); err == nil {
		t.Error("expected an error when the quota doesn't exist")
	}
}

func TestWaitForQuotaUsage_CancelledContextIsAnError(t *testing.T) {
	shortQuotaWait(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForQuotaUsage(ctx, newFakeDynamic(quotaObj(nil)), testNamespace, resourceQuotaName); err == nil {
		t.Error("expected an error when the context is cancelled")
	}
}

// A first deploy that failed after apply leaves a crash-looping Deployment, its
// Service and its route. Stop tears those down and keeps the app's PVCs.
func TestTeardownApp_RemovesWorkloadAndRouteKeepsPVCs(t *testing.T) {
	dyn := newFakeDynamic(
		labelledObj("apps/v1", "Deployment", testApp, testApp),
		labelledObj("v1", "Service", testApp, testApp),
		labelledObj("gateway.networking.k8s.io/v1", "HTTPRoute", testApp, testApp),
		labelledObj("v1", "PersistentVolumeClaim", testApp+"-data", testApp),
	)
	if err := TeardownApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownApp: %v", err)
	}
	for _, gvr := range []schema.GroupVersionResource{gvrDeployment, gvrService, gvrHTTPRoute} {
		if _, err := dyn.Resource(gvr).Namespace(testNamespace).Get(context.Background(), testApp, metav1.GetOptions{}); !errors.IsNotFound(err) {
			t.Errorf("expected %s/%s to be deleted, got err=%v", gvr.Resource, testApp, err)
		}
	}
	if _, err := dyn.Resource(gvrPVC).Namespace(testNamespace).Get(context.Background(), testApp+"-data", metav1.GetOptions{}); err != nil {
		t.Errorf("expected PVC to be kept, got err=%v", err)
	}
}

func TestTeardown_DeletesWorkloadsWithBackgroundPropagation(t *testing.T) {
	dyn := newFakeDynamic(
		labelledObj("apps/v1", "Deployment", testApp, testApp),
		labelledObj("batch/v1", "CronJob", testApp, testApp),
	)
	if err := TeardownApp(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownApp: %v", err)
	}
	if err := TeardownCronJob(context.Background(), dyn, testNamespace, testOwner); err != nil {
		t.Fatalf("TeardownCronJob: %v", err)
	}
	seen := map[string]bool{}
	for _, a := range dyn.Actions() {
		del, ok := a.(clienttesting.DeleteAction)
		if !ok {
			continue
		}
		res := del.GetResource().Resource
		if res != gvrDeployment.Resource && res != gvrCronJob.Resource {
			continue
		}
		seen[res] = true
		if p := del.GetDeleteOptions().PropagationPolicy; p == nil || *p != metav1.DeletePropagationBackground {
			t.Errorf("delete %s: propagationPolicy=%v, want Background", res, p)
		}
	}
	if !seen[gvrDeployment.Resource] || !seen[gvrCronJob.Resource] {
		t.Errorf("expected Deployment and CronJob deletes, saw %v", seen)
	}
}
