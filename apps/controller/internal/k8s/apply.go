// Package k8s provides server-side apply helpers and status checks.
package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	libk8s "canette.dev/lib/k8s"
)

var (
	gvrNamespace  = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}
	gvrSecret     = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	gvrDeployment = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	gvrService    = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}
	gvrHTTPRoute  = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
	gvrCronJob    = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
	gvrPVC        = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "persistentvolumeclaims"}
	gvrConfigMap  = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

	gvrNetworkPolicy = schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"}
)

const fieldManager = "can-controller"

// ApplyResource applies a resource using server-side apply (force=true).
func ApplyResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace string, obj map[string]interface{}) error {
	data, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("marshal resource: %w", err)
	}

	var iface dynamic.ResourceInterface
	if namespace == "" {
		iface = dyn.Resource(gvr)
	} else {
		iface = dyn.Resource(gvr).Namespace(namespace)
	}

	name, _ := objectName(obj)
	_, err = iface.Patch(ctx, name, types.ApplyPatchType, data, metav1.PatchOptions{
		FieldManager: fieldManager,
		Force:        boolPtr(true),
	})
	if err != nil {
		return fmt.Errorf("apply %s/%s: %w", gvr.Resource, name, err)
	}
	return nil
}

// ApplyAll applies Namespace first, then Secrets (env + imagePull), then volumes (PVCs,
// ConfigMaps), then app workload resources.
// For CronJob deployments: applies CronJob only (no Deployment, Service, or HTTPRoute).
// For web/private deployments: applies Deployment, Service, and optionally HTTPRoute.
func ApplyAll(ctx context.Context, dyn dynamic.Interface, res AppResources) error {
	ns, _ := objectName(res.Namespace)
	nsNamespace := "" // cluster-scoped

	if err := ApplyResource(ctx, dyn, gvrNamespace, nsNamespace, res.Namespace); err != nil {
		return fmt.Errorf("apply namespace: %w", err)
	}
	if res.NetworkPolicy != nil {
		if err := ApplyResource(ctx, dyn, gvrNetworkPolicy, ns, res.NetworkPolicy); err != nil {
			return fmt.Errorf("apply networkpolicy: %w", err)
		}
	} else {
		// Global toggle disabled — delete any stale canette-default NetworkPolicy so a
		// chart upgrade that flips the toggle off actually removes the restriction
		// instead of leaving it in place. Idempotent (DeleteResource ignores not-found).
		if err := DeleteResource(ctx, dyn, gvrNetworkPolicy, ns, networkPolicyName); err != nil {
			return fmt.Errorf("delete stale networkpolicy: %w", err)
		}
	}
	if res.Secret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.Secret); err != nil {
			return fmt.Errorf("apply secret: %w", err)
		}
	}
	if res.ImagePullSecret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.ImagePullSecret); err != nil {
			return fmt.Errorf("apply imagepullsecret: %w", err)
		}
	}
	if res.AuthgateSecret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.AuthgateSecret); err != nil {
			return fmt.Errorf("apply authgate secret: %w", err)
		}
	} else {
		// Gate disabled (never enabled, was just disabled, or this is a CronJob
		// which never has one) — delete any stale authgate secret left over from
		// a previous deployment with the gate enabled. Idempotent (DeleteResource
		// ignores not-found), mirrors the stale-HTTPRoute cleanup below.
		if err := DeleteResource(ctx, dyn, gvrSecret, ns, authgateSecretName(res.AppSlug)); err != nil {
			return fmt.Errorf("delete stale authgate secret: %w", err)
		}
	}
	for i, pvc := range res.PVCs {
		pvcName, _ := objectName(pvc)
		if err := ApplyResource(ctx, dyn, gvrPVC, ns, pvc); err != nil {
			return fmt.Errorf("apply pvc[%d] %s: %w", i, pvcName, err)
		}
	}
	for i, cm := range res.ConfigMaps {
		cmName, _ := objectName(cm)
		if err := ApplyResource(ctx, dyn, gvrConfigMap, ns, cm); err != nil {
			return fmt.Errorf("apply configmap[%d] %s: %w", i, cmName, err)
		}
	}
	if res.CronJob != nil {
		if err := ApplyResource(ctx, dyn, gvrCronJob, ns, res.CronJob); err != nil {
			return fmt.Errorf("apply cronjob: %w", err)
		}
		return nil
	}
	if err := ApplyResource(ctx, dyn, gvrDeployment, ns, res.Deployment); err != nil {
		return fmt.Errorf("apply deployment: %w", err)
	}
	if err := ApplyResource(ctx, dyn, gvrService, ns, res.Service); err != nil {
		return fmt.Errorf("apply service: %w", err)
	}
	if res.HTTPRoute != nil {
		if err := ApplyResource(ctx, dyn, gvrHTTPRoute, ns, res.HTTPRoute); err != nil {
			return fmt.Errorf("apply httproute: %w", err)
		}
	} else {
		// Private deployment — delete any HTTPRoute left over from a previous web deployment.
		appName, _ := objectName(res.Deployment)
		if err := DeleteResource(ctx, dyn, gvrHTTPRoute, ns, appName); err != nil {
			return fmt.Errorf("delete stale httproute: %w", err)
		}
	}
	return nil
}

// DeleteVolumeResource deletes a PVC or ConfigMap that was previously managed by canette.
// Ignores not-found errors (idempotent).
func DeleteVolumeResource(ctx context.Context, dyn dynamic.Interface, resourceType, namespace, name string) error {
	var gvr schema.GroupVersionResource
	switch resourceType {
	case "PersistentVolumeClaim":
		gvr = gvrPVC
	case "ConfigMap":
		gvr = gvrConfigMap
	default:
		return fmt.Errorf("unknown volume resource type: %s", resourceType)
	}
	return DeleteResource(ctx, dyn, gvr, namespace, name)
}

// RolloutStatus describes the outcome of watching a Deployment rollout.
type RolloutStatus struct {
	Done      bool
	Succeeded bool
	Message   string
	PodName   string // name of the pod backing a successful rollout; empty otherwise
}

// CheckRollout checks whether the Deployment has finished rolling out.
// deploymentID scopes the pod-failure check to pods belonging to THIS
// deployment (via the canette.dev/deployment label) — without it, a crashing
// pod left over from a previous, still-terminating deployment of the same app
// would be misattributed to the current rollout.
//
// Pod failures are checked before the availability success condition below,
// not after: a pod can pass its readiness check and crash moments later, and
// checking failures first means a crash observed on the very poll that would
// otherwise satisfy AvailableReplicas>=1 is still caught instead of the
// rollout being declared successful.
func CheckRollout(ctx context.Context, client kubernetes.Interface, namespace, name, deploymentID string) (RolloutStatus, error) {
	dep, err := client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			return RolloutStatus{Message: "deployment not found yet"}, nil
		}
		return RolloutStatus{}, fmt.Errorf("get deployment: %w", err)
	}

	// Listing errors fail open (nil pods) — pod-level failure/name detection
	// just degrades, the replica-count based status below is unaffected.
	pods, _ := listDeploymentPods(ctx, client, namespace, name, deploymentID)

	if reason, failed := checkPodsForFailure(pods); failed {
		return RolloutStatus{Done: true, Succeeded: false, Message: reason}, nil
	}

	// Check conditions for failures — only meaningful once K8s has observed the current
	// generation. Stale ProgressDeadlineExceeded conditions from a previous rollout
	// remain on the Deployment after a redeploy until the new rollout completes.
	if dep.Status.ObservedGeneration >= dep.Generation {
		for _, cond := range dep.Status.Conditions {
			if cond.Type == appsv1.DeploymentProgressing && cond.Reason == "ProgressDeadlineExceeded" {
				return RolloutStatus{Done: true, Succeeded: false, Message: cond.Message}, nil
			}
		}
	}

	// Check if all replicas are available and the generation matches
	if dep.Status.ObservedGeneration >= dep.Generation &&
		dep.Status.UpdatedReplicas >= *replicaCount(dep) &&
		dep.Status.AvailableReplicas >= 1 {
		podName := firstRunningPodName(pods)
		msg := "deployment available"
		if podName != "" {
			msg = fmt.Sprintf("deployment available (pod %s)", podName)
		}
		return RolloutStatus{Done: true, Succeeded: true, Message: msg, PodName: podName}, nil
	}

	return RolloutStatus{Message: fmt.Sprintf("waiting: updated=%d available=%d",
		dep.Status.UpdatedReplicas, dep.Status.AvailableReplicas)}, nil
}

// listDeploymentPods lists pods for an app, scoped to a specific deployment ID
// when one is given (see AppDeploymentLabelSelector) — falls back to an
// app-wide selector when deploymentID is empty.
func listDeploymentPods(ctx context.Context, client kubernetes.Interface, namespace, appName, deploymentID string) ([]corev1.Pod, error) {
	selector := libk8s.AppLabelSelector(appName)
	if deploymentID != "" {
		selector = libk8s.AppDeploymentLabelSelector(appName, deploymentID)
	}
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	return pods.Items, nil
}

// checkPodsForFailure inspects pods for known crash/image-pull failure states.
// It checks both a container currently backing off from repeated restarts
// (Waiting) and a container's most recent exit (Terminated with a nonzero
// exit code) — the latter is what makes a pod's FIRST crash visible: kubelet
// only starts backing off into CrashLoopBackOff after several restarts, so a
// pod that has crashed once and not yet been restarted shows up only as
// Terminated, never as Waiting.
func checkPodsForFailure(pods []corev1.Pod) (string, bool) {
	for _, pod := range pods {
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil {
				reason := cs.State.Waiting.Reason
				if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
					return fmt.Sprintf("pod %s: %s", pod.Name, reason), true
				}
			}
			if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
				reason := t.Reason
				if reason == "" {
					reason = "Error"
				}
				return fmt.Sprintf("pod %s: %s (exit %d)", pod.Name, reason, t.ExitCode), true
			}
		}
	}
	return "", false
}

// firstRunningPodName returns the name of the first Running pod, or "".
func firstRunningPodName(pods []corev1.Pod) string {
	for _, pod := range pods {
		if pod.Status.Phase == corev1.PodRunning {
			return pod.Name
		}
	}
	return ""
}

// GetPodLogs retrieves logs from the first running pod for an app since sinceTime.
// Returns nil lines (no error) if no running pod exists.
func GetPodLogs(ctx context.Context, client kubernetes.Interface, namespace, appSlug string, sinceTime *metav1.Time, tailLines int64) ([]string, error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}

	for _, pod := range pods.Items {
		if pod.Status.Phase != corev1.PodRunning {
			continue
		}
		opts := &corev1.PodLogOptions{
			TailLines: &tailLines,
		}
		if sinceTime != nil {
			opts.SinceTime = sinceTime
		}
		req := client.CoreV1().Pods(namespace).GetLogs(pod.Name, opts)
		data, err := req.DoRaw(ctx)
		if err != nil {
			return nil, fmt.Errorf("get pod logs %s: %w", pod.Name, err)
		}
		lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		var result []string
		for _, l := range lines {
			if l != "" {
				result = append(result, l)
			}
		}
		return result, nil
	}
	return nil, nil
}

// DeleteResource deletes a namespaced K8s resource, ignoring not-found errors.
func DeleteResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string) error {
	err := dyn.Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete %s/%s: %w", gvr.Resource, name, err)
	}
	return nil
}

// DeleteNamespace deletes a namespace, ignoring not-found errors.
func DeleteNamespace(ctx context.Context, dyn dynamic.Interface, namespace string) error {
	err := dyn.Resource(gvrNamespace).Delete(ctx, namespace, metav1.DeleteOptions{})
	if err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete namespace %s: %w", namespace, err)
	}
	return nil
}

// TeardownApp deletes the app's Deployment, Service, HTTPRoute, and ConfigMaps.
// The Namespace, Secret, and PVCs are left in place. PVCs hold user data and
// are preserved across Stop so the app can be restarted without data loss —
// they are reclaimed only when the project (namespace) is deleted.
func TeardownApp(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	if err := DeleteResource(ctx, dyn, gvrDeployment, namespace, appSlug); err != nil {
		return err
	}
	if err := DeleteResource(ctx, dyn, gvrService, namespace, appSlug); err != nil {
		return err
	}
	if err := DeleteResource(ctx, dyn, gvrHTTPRoute, namespace, appSlug); err != nil {
		return err
	}
	if err := deleteConfigMapsForApp(ctx, dyn, namespace, appSlug); err != nil {
		return fmt.Errorf("delete configmaps: %w", err)
	}
	return nil
}

// deleteConfigMapsForApp deletes all canette-managed ConfigMaps for the given app
// in the namespace, identified by the canette.dev/app label. ConfigMaps are cheap
// to recreate on the next deploy, so we don't bother queuing them in the DB.
func deleteConfigMapsForApp(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	list, err := dyn.Resource(gvrConfigMap).Namespace(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		if errors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("list configmaps: %w", err)
	}
	for _, cm := range list.Items {
		if err := DeleteResource(ctx, dyn, gvrConfigMap, namespace, cm.GetName()); err != nil {
			return err
		}
	}
	return nil
}

// TeardownCronJob deletes the app's CronJob.
// The Namespace and Secret are left in place (cheap; reused on next deploy).
func TeardownCronJob(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	return DeleteResource(ctx, dyn, gvrCronJob, namespace, appSlug)
}

// DeleteAllPodsForApp force-deletes all pods for an app. Used by teardown to
// clear pods immediately rather than waiting for Deployment cascading deletion.
func DeleteAllPodsForApp(ctx context.Context, client kubernetes.Interface, namespace, appSlug string) error {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		if errors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("list pods: %w", err)
	}
	grace := int64(0)
	for _, pod := range pods.Items {
		if err := client.CoreV1().Pods(namespace).Delete(ctx, pod.Name, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
		}); err != nil && !errors.IsNotFound(err) {
			return fmt.Errorf("delete pod %s: %w", pod.Name, err)
		}
	}
	return nil
}

// DeleteStuckPods force-deletes pods stuck in ImagePullBackOff, ErrImagePull, or
// CrashLoopBackOff. Returns the number of pods deleted.
func DeleteStuckPods(ctx context.Context, client kubernetes.Interface, namespace, appSlug string) (int, error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		if errors.IsNotFound(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("list pods: %w", err)
	}
	grace := int64(0)
	deleted := 0
	for _, pod := range pods.Items {
		stuck := false
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil {
				switch cs.State.Waiting.Reason {
				case "ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff":
					stuck = true
				}
			}
		}
		if !stuck {
			continue
		}
		if err := client.CoreV1().Pods(namespace).Delete(ctx, pod.Name, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
		}); err != nil && !errors.IsNotFound(err) {
			return deleted, fmt.Errorf("delete pod %s: %w", pod.Name, err)
		}
		deleted++
	}
	return deleted, nil
}

func objectName(obj map[string]interface{}) (string, bool) {
	meta, ok := obj["metadata"].(map[string]interface{})
	if !ok {
		return "", false
	}
	name, ok := meta["name"].(string)
	return name, ok
}

func boolPtr(b bool) *bool { return &b }

func replicaCount(dep *appsv1.Deployment) *int32 {
	if dep.Spec.Replicas != nil {
		return dep.Spec.Replicas
	}
	one := int32(1)
	return &one
}
