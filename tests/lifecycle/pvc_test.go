//go:build lifecycle

package lifecycle

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	libk8s "canette.dev/lib/k8s"
)

// Scenario 4 of #330 (see #323): Stop keeps an app's PVCs, and a redeploy
// mounts the same ones again.
func TestStopKeepsPVC(t *testing.T) {
	p := newProject(t, "stop-pvc")
	a := newApp(t, p, "web")
	ns := p.namespace()
	addPVCVolume(t, a, "/data", "100Mi")
	live := deployLive(t, a)

	pvcs := appPVCs(t, ns, a.Slug)
	if len(pvcs) != 1 {
		t.Fatalf("PVCs in %s after deploy = %v, want one", ns, pvcs)
	}

	stopApp(t, a)
	waitWorkloadGone(t, ns, a.Slug, 2*time.Minute)
	time.Sleep(3 * pollInterval) // let any later teardown or cleanup poll run
	requireSamePVCs(t, ns, a.Slug, pvcs)

	next := redeploy(t, live)
	waitDeployment(t, a, next.ID, "live", deployTimeout)
	requireSamePVCs(t, ns, a.Slug, pvcs)
}

// Scenario 4 of #330 (see #323): a slug change never deletes a PVC. The API
// refuses to rename a project whose apps have PVC volumes, and the controller
// keeps the old namespace while a PVC is left in it.
func TestSlugChangeKeepsPVC(t *testing.T) {
	t.Run("rename refused with a PVC volume", func(t *testing.T) {
		p := newProject(t, "rename-vol")
		a := newApp(t, p, "web")
		ns := p.namespace()
		addPVCVolume(t, a, "/data", "100Mi")
		deployLive(t, a)
		pvcs := appPVCs(t, ns, a.Slug)
		stopApp(t, a)
		waitWorkloadGone(t, ns, a.Slug, 2*time.Minute)

		status, body, err := api.raw(http.MethodPatch, "/api/v1/projects/"+p.ID,
			map[string]string{"slug": projectSlug("renamed")})
		if err != nil {
			t.Fatal(err)
		}
		if status != http.StatusConflict || !strings.Contains(string(body), "persistent volumes") {
			t.Fatalf("rename with a PVC volume: HTTP %d %s, want 409 about persistent volumes", status, body)
		}
		time.Sleep(3 * pollInterval)
		requireSamePVCs(t, ns, a.Slug, pvcs)
	})

	t.Run("old namespace kept while it holds a PVC", func(t *testing.T) {
		p := newProject(t, "rename-left")
		a := newApp(t, p, "web")
		oldNS := p.namespace()
		deployLive(t, a)
		stopApp(t, a)
		waitWorkloadGone(t, oldNS, a.Slug, 2*time.Minute)

		// A PVC the app no longer lists, e.g. one whose deletion hasn't run.
		left := leftoverPVC(t, oldNS, a.Slug)

		var renamed project
		api.call(t, http.MethodPatch, "/api/v1/projects/"+p.ID,
			map[string]string{"slug": projectSlug("renamed")}, &renamed)
		if renamed.namespace() == oldNS {
			t.Fatalf("rename kept namespace %s", oldNS)
		}

		waitControllerLog(t, 2*time.Minute, "not deleting renamed project's old namespace", `"namespace":"`+oldNS+`"`)
		if !namespaceExists(t, oldNS) {
			t.Fatalf("old namespace %s was deleted while it held PVC %s", oldNS, left)
		}
		requireSamePVCs(t, oldNS, a.Slug, map[string]types.UID{"lifecycle-left": left})
	})
}

// leftoverPVC creates a PVC labelled for the app, as one Canette created and
// didn't delete, and returns its UID. It stays Pending: nothing mounts it.
func leftoverPVC(t *testing.T, ns, appSlug string) types.UID {
	t.Helper()
	pvc, err := kube.CoreV1().PersistentVolumeClaims(ns).Create(context.Background(), &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: "lifecycle-left",
			Labels: map[string]string{
				libk8s.LabelManagedBy: libk8s.LabelManagedByVal,
				libk8s.LabelApp:       appSlug,
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Mi")},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("create leftover PVC in %s: %v", ns, err)
	}
	return pvc.UID
}
