// Package k8s provides server-side apply helpers and status checks.
package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"canette.dev/lib/failpoint"
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
	gvrPDB           = schema.GroupVersionResource{Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"}
	gvrResourceQuota = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "resourcequotas"}
	gvrLimitRange    = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "limitranges"}
)

const fieldManager = "can-controller"

// ApplyResource applies a resource using server-side apply (force=true).
func ApplyResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace string, obj map[string]interface{}) error {
	_, err := applyResource(ctx, dyn, gvr, namespace, obj)
	return err
}

// applyResource is ApplyResource, returning the object as applied.
func applyResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace string, obj map[string]interface{}) (*unstructured.Unstructured, error) {
	data, err := json.Marshal(obj)
	if err != nil {
		return nil, fmt.Errorf("marshal resource: %w", err)
	}

	var iface dynamic.ResourceInterface
	if namespace == "" {
		iface = dyn.Resource(gvr)
	} else {
		iface = dyn.Resource(gvr).Namespace(namespace)
	}

	name, _ := objectName(obj)
	applied, err := iface.Patch(ctx, name, types.ApplyPatchType, data, metav1.PatchOptions{
		FieldManager: fieldManager,
		Force:        boolPtr(true),
	})
	if err != nil {
		return nil, fmt.Errorf("apply %s/%s: %w", gvr.Resource, name, err)
	}
	return applied, nil
}

// AppliedWorkload identifies the Deployment or CronJob an apply wrote (#332):
// its UID, which changes when the object is deleted and created again under
// the same name, and the metadata.generation of the spec that was applied.
// The zero value means unknown.
type AppliedWorkload struct {
	UID        string
	Generation int64
}

func appliedWorkload(obj *unstructured.Unstructured) AppliedWorkload {
	if obj == nil {
		return AppliedWorkload{}
	}
	return AppliedWorkload{UID: string(obj.GetUID()), Generation: obj.GetGeneration()}
}

// ApplyAll applies Namespace first, then Secrets (env + imagePull), then volumes (PVCs,
// ConfigMaps), then app workload resources.
// For CronJob deployments: applies CronJob only (no Deployment, Service, or HTTPRoute).
// For web/private deployments: applies Deployment, Service, and optionally HTTPRoute.
// It returns the identity of the workload it applied.
func ApplyAll(ctx context.Context, dyn dynamic.Interface, res AppResources) (AppliedWorkload, error) {
	var none AppliedWorkload
	ns, _ := objectName(res.Namespace)
	nsNamespace := "" // cluster-scoped

	if err := ApplyResource(ctx, dyn, gvrNamespace, nsNamespace, res.Namespace); err != nil {
		return none, fmt.Errorf("apply namespace: %w", err)
	}
	if res.NetworkPolicy != nil {
		if err := ApplyResource(ctx, dyn, gvrNetworkPolicy, ns, res.NetworkPolicy); err != nil {
			return none, fmt.Errorf("apply networkpolicy: %w", err)
		}
	} else {
		// Global toggle disabled — delete any stale canette-default NetworkPolicy so a
		// chart upgrade that flips the toggle off actually removes the restriction
		// instead of leaving it in place. Idempotent (DeleteResource ignores not-found).
		if err := DeleteResource(ctx, dyn, gvrNetworkPolicy, ns, networkPolicyName); err != nil {
			return none, fmt.Errorf("delete stale networkpolicy: %w", err)
		}
	}
	// Quota and LimitRange go before any workload, so new pods get the
	// LimitRange defaults. When disabled, any copy left from an earlier
	// configuration is deleted (idempotent), like the NetworkPolicy above.
	if err := applyOrDelete(ctx, dyn, gvrResourceQuota, ns, resourceQuotaName, res.ResourceQuota); err != nil {
		return none, fmt.Errorf("resourcequota: %w", err)
	}
	if res.ResourceQuota != nil {
		if err := waitForQuotaUsage(ctx, dyn, ns, resourceQuotaName); err != nil {
			return none, fmt.Errorf("resourcequota: %w", err)
		}
	}
	if err := applyOrDelete(ctx, dyn, gvrLimitRange, ns, limitRangeName, res.LimitRange); err != nil {
		return none, fmt.Errorf("limitrange: %w", err)
	}
	if res.Secret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.Secret); err != nil {
			return none, fmt.Errorf("apply secret: %w", err)
		}
	}
	if res.ImagePullSecret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.ImagePullSecret); err != nil {
			return none, fmt.Errorf("apply imagepullsecret: %w", err)
		}
	}
	if res.AuthgateSecret != nil {
		if err := ApplyResource(ctx, dyn, gvrSecret, ns, res.AuthgateSecret); err != nil {
			return none, fmt.Errorf("apply authgate secret: %w", err)
		}
	} else {
		// Gate disabled (never enabled, was just disabled, or this is a CronJob
		// which never has one) — delete any stale authgate secret left over from
		// a previous deployment with the gate enabled. Idempotent (DeleteResource
		// ignores not-found), mirrors the stale-HTTPRoute cleanup below.
		if err := DeleteResource(ctx, dyn, gvrSecret, ns, authgateSecretName(res.AppSlug)); err != nil {
			return none, fmt.Errorf("delete stale authgate secret: %w", err)
		}
	}
	for i, pvc := range res.PVCs {
		pvcName, _ := objectName(pvc)
		pvc, err := keepLiveStorageClass(ctx, dyn, ns, pvc)
		if err != nil {
			return none, fmt.Errorf("pvc[%d] %s: %w", i, pvcName, err)
		}
		if err := ApplyResource(ctx, dyn, gvrPVC, ns, pvc); err != nil {
			return none, fmt.Errorf("apply pvc[%d] %s: %w", i, pvcName, err)
		}
	}
	for i, cm := range res.ConfigMaps {
		cmName, _ := objectName(cm)
		if err := ApplyResource(ctx, dyn, gvrConfigMap, ns, cm); err != nil {
			return none, fmt.Errorf("apply configmap[%d] %s: %w", i, cmName, err)
		}
	}
	if res.CronJob != nil {
		cronJob, err := applyResource(ctx, dyn, gvrCronJob, ns, res.CronJob)
		if err != nil {
			return none, fmt.Errorf("apply cronjob: %w", err)
		}
		// The app may have been a multi-replica web/private app before.
		if err := DeleteResource(ctx, dyn, gvrPDB, ns, res.AppSlug); err != nil {
			return none, fmt.Errorf("delete stale poddisruptionbudget: %w", err)
		}
		return appliedWorkload(cronJob), nil
	}
	if err := clearRollingUpdateForRecreate(ctx, dyn, ns, res.Deployment); err != nil {
		return none, fmt.Errorf("prepare deployment strategy: %w", err)
	}
	deployment, err := applyResource(ctx, dyn, gvrDeployment, ns, res.Deployment)
	if err != nil {
		return none, fmt.Errorf("apply deployment: %w", err)
	}
	// The new Deployment is applied, its Service and HTTPRoute are not.
	failpoint.Hit("after-partial-apply")
	if res.PodDisruptionBudget != nil {
		if err := ApplyResource(ctx, dyn, gvrPDB, ns, res.PodDisruptionBudget); err != nil {
			return none, fmt.Errorf("apply poddisruptionbudget: %w", err)
		}
	} else {
		// Replicas dropped back to 1 — a leftover maxUnavailable: 1 PDB would
		// block node drains entirely, so remove it.
		if err := DeleteResource(ctx, dyn, gvrPDB, ns, res.AppSlug); err != nil {
			return none, fmt.Errorf("delete stale poddisruptionbudget: %w", err)
		}
	}
	if err := ApplyResource(ctx, dyn, gvrService, ns, res.Service); err != nil {
		return none, fmt.Errorf("apply service: %w", err)
	}
	if res.HTTPRoute != nil {
		if err := ApplyResource(ctx, dyn, gvrHTTPRoute, ns, res.HTTPRoute); err != nil {
			return none, fmt.Errorf("apply httproute: %w", err)
		}
	} else {
		// Private deployment — delete any HTTPRoute left over from a previous web deployment.
		appName, _ := objectName(res.Deployment)
		if err := DeleteResource(ctx, dyn, gvrHTTPRoute, ns, appName); err != nil {
			return none, fmt.Errorf("delete stale httproute: %w", err)
		}
	}
	return appliedWorkload(deployment), nil
}

// applyOrDelete applies obj, or deletes the resource called name when obj is nil.
func applyOrDelete(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string, obj map[string]interface{}) error {
	if obj != nil {
		return ApplyResource(ctx, dyn, gvr, namespace, obj)
	}
	return DeleteResource(ctx, dyn, gvr, namespace, name)
}

// How long ApplyAll waits for a new ResourceQuota's usage to be calculated.
// Variables so tests can shorten them.
var (
	quotaUsageTimeout  = 10 * time.Second
	quotaUsageInterval = 250 * time.Millisecond
)

// waitForQuotaUsage waits until the quota controller has calculated
// status.used for every resource in the quota's spec.hard. Until then the
// API server rejects anything the quota counts ("status unknown for quota"),
// so the PVCs, Secrets and ConfigMaps applied right after a new or changed
// quota would fail. Returns at once when usage is already known. On timeout
// it returns nil and lets the deploy go ahead: if an object is still
// rejected, the deploy fails with the API server's own error.
func waitForQuotaUsage(ctx context.Context, dyn dynamic.Interface, namespace, name string) error {
	err := wait.PollUntilContextTimeout(ctx, quotaUsageInterval, quotaUsageTimeout, true, func(ctx context.Context) (bool, error) {
		q, err := dyn.Resource(gvrResourceQuota).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, fmt.Errorf("get resourcequota %s: %w", name, err)
		}
		hard, _, _ := unstructured.NestedMap(q.Object, "spec", "hard")
		used, _, _ := unstructured.NestedMap(q.Object, "status", "used")
		for k := range hard {
			if _, ok := used[k]; !ok {
				return false, nil
			}
		}
		return true, nil
	})
	if err != nil && ctx.Err() == nil && wait.Interrupted(err) {
		return nil
	}
	return err
}

// keepLiveStorageClass returns the PVC to apply with spec.storageClassName
// set to the live PVC's value when the PVC already exists. The field is
// immutable, so applying a different class (e.g. after the Helm value
// changed) would fail every deploy of that app. New PVCs are returned as is.
func keepLiveStorageClass(ctx context.Context, dyn dynamic.Interface, namespace string, pvc map[string]interface{}) (map[string]interface{}, error) {
	name, _ := objectName(pvc)
	live, err := dyn.Resource(gvrPVC).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			return pvc, nil
		}
		return nil, fmt.Errorf("get pvc: %w", err)
	}
	liveClass, found, _ := unstructured.NestedString(live.Object, "spec", "storageClassName")

	spec, _ := pvc["spec"].(map[string]interface{})
	newSpec := make(map[string]interface{}, len(spec)+1)
	for k, v := range spec {
		newSpec[k] = v
	}
	if found {
		newSpec["storageClassName"] = liveClass
	} else {
		delete(newSpec, "storageClassName")
	}
	out := shallowCopy(pvc)
	out["spec"] = newSpec
	return out, nil
}

// clearRollingUpdateForRecreate removes spec.strategy.rollingUpdate from a live
// Deployment before it is switched to the Recreate strategy. The API server
// rejects Recreate while rollingUpdate is set, and server-side apply won't
// remove it when it came from API defaulting, since no field manager owns it.
// No-op when the desired strategy isn't Recreate or the Deployment doesn't exist.
func clearRollingUpdateForRecreate(ctx context.Context, dyn dynamic.Interface, namespace string, desired map[string]interface{}) error {
	desiredType, _, _ := unstructured.NestedString(desired, "spec", "strategy", "type")
	if desiredType != "Recreate" {
		return nil
	}
	name, _ := objectName(desired)
	live, err := dyn.Resource(gvrDeployment).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("get deployment %s: %w", name, err)
	}
	if _, found, _ := unstructured.NestedMap(live.Object, "spec", "strategy", "rollingUpdate"); !found {
		return nil
	}
	patch := []byte(`{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}`)
	if _, err := dyn.Resource(gvrDeployment).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{
		FieldManager: fieldManager,
	}); err != nil {
		return fmt.Errorf("patch deployment %s strategy: %w", name, err)
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
	// Details holds Kubernetes identifiers that explain Message, such as
	// object UIDs, for the deployment log next to its manifest. They are
	// Kubernetes-specific, so they stay out of Message, which becomes the
	// deployment's error.
	Details string
	PodName   string // name of the pod backing a successful rollout; empty otherwise
	// Revision is the Deployment's deployment.kubernetes.io/revision once the
	// rollout succeeded; empty otherwise.
	Revision string
}

// revisionAnnotation is where the Deployment controller numbers the
// ReplicaSet revisions of a Deployment.
const revisionAnnotation = "deployment.kubernetes.io/revision"

// CheckRollout checks whether the Deployment has finished rolling out.
// deploymentID scopes the pod-failure check to pods belonging to THIS
// deployment (via the canette.dev/deployment label) — without it, a crashing
// pod left over from a previous, still-terminating deployment of the same app
// would be misattributed to the current rollout.
//
// Pod failures are checked before the availability success condition below,
// not after: a pod can pass its readiness check and crash moments later, and
// checking failures first means a crash observed on the very poll that would
// otherwise satisfy the completion check is still caught instead of the
// rollout being declared successful.
//
// Completion mirrors kubectl rollout status: every desired replica is updated,
// no old-ReplicaSet pods remain, and every updated pod is available. Checking
// only AvailableReplicas>=1 is wrong mid-rollout — the old pod is still ready
// and keeps AvailableReplicas at 1 while the new pod is still starting.
//
// applied is what the apply wrote (#332). A Deployment with another UID was
// deleted and created again since, by someone else, so the rollout fails
// rather than succeeding on an object canette didn't apply. The rollout is
// only done once Kubernetes has observed the applied generation. A zero
// applied skips both checks.
func CheckRollout(ctx context.Context, client kubernetes.Interface, namespace, name, deploymentID string, applied AppliedWorkload) (RolloutStatus, error) {
	dep, err := client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			if applied.UID != "" {
				return RolloutStatus{Done: true, Message: "the Deployment was deleted during the rollout",
					Details: fmt.Sprintf("applied Deployment UID %s", applied.UID)}, nil
			}
			return RolloutStatus{Message: "deployment not found yet"}, nil
		}
		return RolloutStatus{}, fmt.Errorf("get deployment: %w", err)
	}
	if applied.UID != "" && string(dep.UID) != applied.UID {
		return RolloutStatus{Done: true, Message: "the Deployment was deleted and created again during the rollout",
			Details: fmt.Sprintf("Deployment UID %s, applied UID %s", dep.UID, applied.UID)}, nil
	}
	observed := dep.Status.ObservedGeneration >= max(dep.Generation, applied.Generation)

	// Listing errors fail open (nil pods) — pod-level failure/name detection
	// just degrades, the replica-count based status below is unaffected.
	pods, _ := listDeploymentPods(ctx, client, namespace, name, deploymentID)

	if reason, failed := checkPodsForFailure(pods); failed {
		return RolloutStatus{Done: true, Succeeded: false, Message: reason}, nil
	}

	// Check conditions for failures — only meaningful once K8s has observed the current
	// generation. Stale ProgressDeadlineExceeded conditions from a previous rollout
	// remain on the Deployment after a redeploy until the new rollout completes.
	if observed {
		for _, cond := range dep.Status.Conditions {
			if cond.Type == appsv1.DeploymentProgressing && cond.Reason == "ProgressDeadlineExceeded" {
				return RolloutStatus{Done: true, Succeeded: false, Message: cond.Message}, nil
			}
		}
	}

	if observed &&
		dep.Status.UpdatedReplicas >= *replicaCount(dep) &&
		dep.Status.Replicas <= dep.Status.UpdatedReplicas &&
		dep.Status.AvailableReplicas >= dep.Status.UpdatedReplicas {
		podName := firstRunningPodName(pods)
		msg := "deployment available"
		if podName != "" {
			msg = fmt.Sprintf("deployment available (pod %s)", podName)
		}
		return RolloutStatus{Done: true, Succeeded: true, Message: msg, PodName: podName, Revision: dep.Annotations[revisionAnnotation]}, nil
	}

	return RolloutStatus{Message: fmt.Sprintf("waiting: desired=%d total=%d updated=%d available=%d",
		*replicaCount(dep), dep.Status.Replicas, dep.Status.UpdatedReplicas, dep.Status.AvailableReplicas)}, nil
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
	return deleteResource(ctx, dyn, gvr, namespace, name, metav1.DeleteOptions{})
}

// deleteWorkload deletes a Deployment or CronJob with Background propagation:
// the object goes at once and the garbage collector then removes its
// ReplicaSets/Jobs and their Pods, each Pod with its normal termination grace
// period. Set explicitly because the default propagation differs between
// resource types and API versions.
func deleteWorkload(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string) error {
	background := metav1.DeletePropagationBackground
	return deleteResource(ctx, dyn, gvr, namespace, name, metav1.DeleteOptions{PropagationPolicy: &background})
}

func deleteResource(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace, name string, opts metav1.DeleteOptions) error {
	err := dyn.Resource(gvr).Namespace(namespace).Delete(ctx, name, opts)
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

// ListPVCNames returns the names of every PVC in the namespace, canette-managed
// or not. A missing namespace has none.
func ListPVCNames(ctx context.Context, dyn dynamic.Interface, namespace string) ([]string, error) {
	list, err := dyn.Resource(gvrPVC).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("list pvcs: %w", err)
	}
	names := make([]string, 0, len(list.Items))
	for _, pvc := range list.Items {
		names = append(names, pvc.GetName())
	}
	return names, nil
}

// TeardownApp deletes the app's Deployment, Service, HTTPRoute, PodDisruptionBudget, and ConfigMaps.
// The Namespace, Secret, and PVCs are left in place. PVCs hold user data and
// are preserved across Stop so the app can be restarted without data loss —
// they are reclaimed when the app is deleted (DeleteApp) or with the project's namespace.
func TeardownApp(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	if err := deleteWorkload(ctx, dyn, gvrDeployment, namespace, appSlug); err != nil {
		return err
	}
	if err := DeleteResource(ctx, dyn, gvrService, namespace, appSlug); err != nil {
		return err
	}
	if err := DeleteResource(ctx, dyn, gvrHTTPRoute, namespace, appSlug); err != nil {
		return err
	}
	if err := DeleteResource(ctx, dyn, gvrPDB, namespace, appSlug); err != nil {
		return err
	}
	if err := deleteConfigMapsForApp(ctx, dyn, namespace, appSlug); err != nil {
		return fmt.Errorf("delete configmaps: %w", err)
	}
	return nil
}

// DeleteApp removes everything a deleted app owned in its namespace: the
// workload of either deployment type, its routes, its own Secrets, and its
// PVCs and ConfigMaps. Secrets are deleted by name, not by label, because the
// namespace-wide registry pull Secret carries the label of whichever app last
// applied it. The namespace itself stays, other apps may still use it.
func DeleteApp(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	if err := TeardownApp(ctx, dyn, namespace, appSlug); err != nil {
		return err
	}
	if err := TeardownCronJob(ctx, dyn, namespace, appSlug); err != nil {
		return err
	}
	for _, name := range []string{secretName(appSlug), authgateSecretName(appSlug)} {
		if err := DeleteResource(ctx, dyn, gvrSecret, namespace, name); err != nil {
			return err
		}
	}
	return deletePVCsForApp(ctx, dyn, namespace, appSlug)
}

// deletePVCsForApp deletes every PVC labelled with the app, including ones
// whose volume was removed from canette but whose deletion never ran.
func deletePVCsForApp(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	list, err := dyn.Resource(gvrPVC).Namespace(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: libk8s.AppLabelSelector(appSlug),
	})
	if err != nil {
		if errors.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("list pvcs: %w", err)
	}
	for _, pvc := range list.Items {
		if err := DeleteResource(ctx, dyn, gvrPVC, namespace, pvc.GetName()); err != nil {
			return err
		}
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

// TeardownCronJob deletes the app's CronJob, plus any PodDisruptionBudget left
// over from when the app was a multi-replica web/private app.
// The Namespace and Secret are left in place (cheap; reused on next deploy).
func TeardownCronJob(ctx context.Context, dyn dynamic.Interface, namespace, appSlug string) error {
	if err := deleteWorkload(ctx, dyn, gvrCronJob, namespace, appSlug); err != nil {
		return err
	}
	return DeleteResource(ctx, dyn, gvrPDB, namespace, appSlug)
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
