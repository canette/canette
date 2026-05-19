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
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	gvrNamespace  = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}
	gvrSecret     = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	gvrDeployment = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	gvrService    = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}
	gvrHTTPRoute  = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
	gvrCronJob    = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
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

// ApplyAll applies Namespace first, then Secrets (env + imagePull), then app workload resources.
// For CronJob deployments: applies CronJob only (no Deployment, Service, or HTTPRoute).
// For web/private deployments: applies Deployment, Service, and optionally HTTPRoute.
func ApplyAll(ctx context.Context, dyn dynamic.Interface, res AppResources) error {
	ns, _ := objectName(res.Namespace)
	nsNamespace := "" // cluster-scoped

	if err := ApplyResource(ctx, dyn, gvrNamespace, nsNamespace, res.Namespace); err != nil {
		return fmt.Errorf("apply namespace: %w", err)
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
	}
	return nil
}

// RolloutStatus describes the outcome of watching a Deployment rollout.
type RolloutStatus struct {
	Done      bool
	Succeeded bool
	Message   string
}

// CheckRollout checks whether the Deployment has finished rolling out.
func CheckRollout(ctx context.Context, client kubernetes.Interface, namespace, name string) (RolloutStatus, error) {
	dep, err := client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			return RolloutStatus{Message: "deployment not found yet"}, nil
		}
		return RolloutStatus{}, fmt.Errorf("get deployment: %w", err)
	}

	// Check if all replicas are available and the generation matches
	if dep.Status.ObservedGeneration >= dep.Generation &&
		dep.Status.UpdatedReplicas >= *replicaCount(dep) &&
		dep.Status.AvailableReplicas >= 1 {
		return RolloutStatus{Done: true, Succeeded: true, Message: "deployment available"}, nil
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

	// Check pods for crash/image pull failures
	if reason, failed := checkPodsForFailure(ctx, client, namespace, name); failed {
		return RolloutStatus{Done: true, Succeeded: false, Message: reason}, nil
	}

	return RolloutStatus{Message: fmt.Sprintf("waiting: updated=%d available=%d",
		dep.Status.UpdatedReplicas, dep.Status.AvailableReplicas)}, nil
}

func checkPodsForFailure(ctx context.Context, client kubernetes.Interface, namespace, appName string) (string, bool) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labels.Set{"canette.dev/app": appName}.String(),
	})
	if err != nil {
		return "", false
	}
	for _, pod := range pods.Items {
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Waiting != nil {
				reason := cs.State.Waiting.Reason
				if reason == "CrashLoopBackOff" || reason == "ImagePullBackOff" || reason == "ErrImagePull" {
					return fmt.Sprintf("pod %s: %s", pod.Name, reason), true
				}
			}
		}
	}
	return "", false
}

// GetPodLogs retrieves logs from the first running pod for an app since sinceTime.
// Returns nil lines (no error) if no running pod exists.
func GetPodLogs(ctx context.Context, client kubernetes.Interface, namespace, appSlug string, sinceTime *metav1.Time, tailLines int64) ([]string, error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labels.Set{"canette.dev/app": appSlug}.String(),
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

// TeardownApp deletes the app's Deployment, Service, and HTTPRoute.
// The Namespace and Secret are left in place (cheap; reused on next deploy).
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
		LabelSelector: labels.Set{"canette.dev/app": appSlug}.String(),
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
		LabelSelector: labels.Set{"canette.dev/app": appSlug}.String(),
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
