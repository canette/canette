//go:build lifecycle

package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"canette.dev/lib/failpoint"
	libk8s "canette.dev/lib/k8s"
)

const controllerSelector = "app.kubernetes.io/name=canette-controller"

// setFailpoints sets the chart's controller.failpoints and waits for the new
// controller pod. The chart recreates the pod, so every point is armed again.
func setFailpoints(t *testing.T, names ...string) {
	t.Helper()
	if names == nil {
		names = []string{}
	}
	value, err := json.Marshal(names)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("helm", "upgrade", env.Release, env.ChartDir,
		"--kubeconfig", env.Kubeconfig, "-n", env.ReleaseNamespace,
		"--reuse-values", "--set-json", "controller.failpoints="+string(value),
		"--wait", "--timeout", "3m")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("helm upgrade with controller.failpoints=%s: %v\n%s", value, err, out)
	}
	baseRestarts = waitControllerReady(t, -1)
}

// baseRestarts is the controller container's restart count once the pod
// setFailpoints rolled out is ready. A new pod can restart once before any
// failpoint: its first database connection may be refused until the
// NetworkPolicy allowing its IP is in place.
var baseRestarts int32

// armFailpoint arms one failpoint for the rest of the test and disarms it,
// with a fresh controller, when the test ends.
func armFailpoint(t *testing.T, name string) {
	t.Helper()
	setFailpoints(t, name)
	t.Cleanup(func() { setFailpoints(t) })
}

// controllerPod returns the one controller pod that isn't being deleted.
func controllerPod(t *testing.T) (*corev1.Pod, error) {
	t.Helper()
	pods, err := kube.CoreV1().Pods(env.ReleaseNamespace).List(context.Background(),
		metav1.ListOptions{LabelSelector: controllerSelector})
	if err != nil {
		return nil, err
	}
	var live []corev1.Pod
	for _, p := range pods.Items {
		if p.DeletionTimestamp == nil {
			live = append(live, p)
		}
	}
	if len(live) != 1 {
		return nil, fmt.Errorf("%d controller pods, want 1", len(live))
	}
	return &live[0], nil
}

func controllerStatus(p *corev1.Pod) (corev1.ContainerStatus, bool) {
	for _, s := range p.Status.ContainerStatuses {
		if s.Name == "controller" {
			return s, true
		}
	}
	return corev1.ContainerStatus{}, false
}

// waitControllerReady waits until the controller container is ready and has
// restarted exactly restarts times (any number when restarts is negative),
// and returns its restart count.
func waitControllerReady(t *testing.T, restarts int32) int32 {
	t.Helper()
	var count int32
	eventually(t, 3*time.Minute, 2*time.Second, "the controller to be ready", func() (bool, error) {
		p, err := controllerPod(t)
		if err != nil {
			return false, err
		}
		s, ok := controllerStatus(p)
		if !ok {
			return false, nil
		}
		count = s.RestartCount
		if restarts < 0 {
			return s.Ready, nil
		}
		if s.RestartCount > restarts {
			return false, fmt.Errorf("controller restarted %d times, want %d", s.RestartCount, restarts)
		}
		return s.Ready && s.RestartCount == restarts, nil
	})
	return count
}

// waitFailpointFired waits until the controller exited at the named
// failpoint, once since setFailpoints, and is ready again.
func waitFailpointFired(t *testing.T, name string, timeout time.Duration) {
	t.Helper()
	eventually(t, timeout, 2*time.Second, "failpoint "+name+" to fire", func() (bool, error) {
		p, err := controllerPod(t)
		if err != nil {
			return false, err
		}
		s, ok := controllerStatus(p)
		if !ok || s.RestartCount <= baseRestarts {
			return false, nil
		}
		if term := s.LastTerminationState.Terminated; term == nil || term.ExitCode != failpoint.ExitCode {
			return false, fmt.Errorf("controller restarted, but not with status %d: %+v", failpoint.ExitCode, s.LastTerminationState)
		}
		return true, nil
	})
	p, err := controllerPod(t)
	if err != nil {
		t.Fatal(err)
	}
	logs := controllerLogs(t, p, true)
	if want := "failpoint " + name + ": exiting"; !strings.Contains(logs, want) {
		t.Fatalf("the controller exited with status %d, but its log lacks %q:\n%s", failpoint.ExitCode, want, tail(logs, 20))
	}
	waitControllerReady(t, baseRestarts+1)
}

func controllerLogs(t *testing.T, p *corev1.Pod, previous bool) string {
	t.Helper()
	data, err := kube.CoreV1().Pods(p.Namespace).GetLogs(p.Name, &corev1.PodLogOptions{
		Container: "controller",
		Previous:  previous,
	}).DoRaw(context.Background())
	if err != nil {
		t.Fatalf("logs of %s (previous=%t): %v", p.Name, previous, err)
	}
	return string(data)
}

// waitControllerLog waits until a line of the running controller container's
// log contains every string in want (a message and, say, its namespace).
func waitControllerLog(t *testing.T, timeout time.Duration, want ...string) {
	t.Helper()
	eventually(t, timeout, 5*time.Second, fmt.Sprintf("the controller to log %q", want), func() (bool, error) {
		p, err := controllerPod(t)
		if err != nil {
			return false, err
		}
		for _, line := range strings.Split(controllerLogs(t, p, false), "\n") {
			if containsAll(line, want) {
				return true, nil
			}
		}
		return false, nil
	})
}

func containsAll(s string, subs []string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// appPVCs returns the app's PVCs by name.
func appPVCs(t *testing.T, ns, appSlug string) map[string]types.UID {
	t.Helper()
	list, err := kube.CoreV1().PersistentVolumeClaims(ns).List(context.Background(),
		metav1.ListOptions{LabelSelector: libk8s.AppLabelSelector(appSlug)})
	if err != nil {
		t.Fatalf("list PVCs in %s: %v", ns, err)
	}
	out := make(map[string]types.UID, len(list.Items))
	for _, pvc := range list.Items {
		out[pvc.Name] = pvc.UID
	}
	return out
}

// requireSamePVCs fails the test unless the app has exactly the PVCs in want,
// with the same UIDs (not deleted and re-created).
func requireSamePVCs(t *testing.T, ns, appSlug string, want map[string]types.UID) {
	t.Helper()
	got := appPVCs(t, ns, appSlug)
	for name, uid := range want {
		switch g, ok := got[name]; {
		case !ok:
			t.Errorf("PVC %s/%s was deleted", ns, name)
		case g != uid:
			t.Errorf("PVC %s/%s was re-created (UID %s, was %s)", ns, name, g, uid)
		}
	}
	if len(got) != len(want) {
		t.Errorf("PVCs in %s = %v, want %v", ns, got, want)
	}
}

// workloadExists reports whether the app's Deployment exists.
func workloadExists(t *testing.T, ns, appSlug string) (bool, error) {
	t.Helper()
	_, err := kube.AppsV1().Deployments(ns).Get(context.Background(), appSlug, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// serviceExists reports whether the app's Service exists.
func serviceExists(t *testing.T, ns, appSlug string) (bool, error) {
	t.Helper()
	_, err := kube.CoreV1().Services(ns).Get(context.Background(), appSlug, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// waitWorkloadGone waits until the app's Deployment is deleted.
func waitWorkloadGone(t *testing.T, ns, appSlug string, timeout time.Duration) {
	t.Helper()
	eventually(t, timeout, 3*time.Second, fmt.Sprintf("Deployment %s/%s to be deleted", ns, appSlug), func() (bool, error) {
		exists, err := workloadExists(t, ns, appSlug)
		return !exists, err
	})
}

func namespaceExists(t *testing.T, ns string) bool {
	t.Helper()
	got, err := kube.CoreV1().Namespaces().Get(context.Background(), ns, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false
	}
	if err != nil {
		t.Fatalf("get namespace %s: %v", ns, err)
	}
	return got.DeletionTimestamp == nil
}

// appObjectsLeft lists the app's Secrets, ConfigMaps and PVCs, which
// DeleteApp removes. The namespace's registry pull Secret is skipped: it
// carries the label of whichever app applied it last and outlives the app.
func appObjectsLeft(t *testing.T, ns, appSlug string) []string {
	t.Helper()
	ctx := context.Background()
	opts := metav1.ListOptions{LabelSelector: libk8s.AppLabelSelector(appSlug)}
	var left []string
	secrets, err := kube.CoreV1().Secrets(ns).List(ctx, opts)
	if err != nil {
		t.Fatalf("list Secrets in %s: %v", ns, err)
	}
	for _, s := range secrets.Items {
		if s.Name != registryPullSecret {
			left = append(left, "secret/"+s.Name)
		}
	}
	configMaps, err := kube.CoreV1().ConfigMaps(ns).List(ctx, opts)
	if err != nil {
		t.Fatalf("list ConfigMaps in %s: %v", ns, err)
	}
	for _, cm := range configMaps.Items {
		left = append(left, "configmap/"+cm.Name)
	}
	for name := range appPVCs(t, ns, appSlug) {
		left = append(left, "pvc/"+name)
	}
	return left
}

// registryPullSecret is the controller's imagePullSecret name
// (reconcile in apps/controller/internal/controller).
const registryPullSecret = "canette-registry-creds"

// pollInterval is the chart's default controller.pollInterval; waiting a few
// of them lets the controller act on queued work.
const pollInterval = 5 * time.Second
