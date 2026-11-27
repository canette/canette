package health

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"go.uber.org/zap"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"canette.dev/controller/internal/store"
	libk8s "canette.dev/lib/k8s"
)

const (
	// statusReadInterval is how often the status reader re-reads every live
	// app's workload object. These are periodic bounded reads, not a watch:
	// capacity and CronJob outcomes change slowly enough that a minute of
	// latency is fine for a background signal.
	statusReadInterval = time.Minute

	// statusReadTimeout bounds the reads for one app, so one slow namespace
	// can't stall the whole pass.
	statusReadTimeout = 10 * time.Second
)

// Workload presence values in KubernetesStatus.Workload.
const (
	WorkloadPresent = "present"
	WorkloadMissing = "missing"
)

// Job outcome values in JobStatus.Outcome.
const (
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobFailed    = "failed"
)

// KubernetesStatus is what Kubernetes reports for an app's workload object,
// stored as JSON in app_observed_status.kubernetes_status and mirrored by the
// KubernetesStatus type in packages/types. It is the "Kubernetes readiness"
// signal: separate from runtime health, which is the verdict on the pods.
type KubernetesStatus struct {
	// Workload is "present" or "missing": whether the Deployment (web,
	// private) or CronJob (cronjob) exists at all.
	Workload string `json:"workload"`
	// Replicas is set for a present Deployment.
	Replicas *ReplicaStatus `json:"replicas,omitempty"`
	// Serving is set for a present Deployment: the deployments whose pods
	// are ready, by their canette.dev/deployment label, most ready pods
	// first (#332). During a rolling update both the old and the new one
	// serve. Empty when no pod is ready.
	Serving []ServingDeployment `json:"serving,omitempty"`
	// CronJob is set for a present CronJob.
	CronJob *CronJobStatus `json:"cronJob,omitempty"`
}

// ReplicaStatus is a Deployment's desired replica count and its status
// counters. Available below Desired means the app is serving at reduced
// capacity, which can happen while the Deployment as a whole is available.
type ReplicaStatus struct {
	Desired   int32 `json:"desired"`
	Ready     int32 `json:"ready"`
	Available int32 `json:"available"`
	Updated   int32 `json:"updated"`
}

// ServingDeployment is a deployment with ready pods.
type ServingDeployment struct {
	DeploymentID string `json:"deploymentId"`
	ReadyPods    int32  `json:"readyPods"`
}

// CronJobStatus is a CronJob's state and the outcome of its newest Job.
type CronJobStatus struct {
	Suspended          bool       `json:"suspended"`
	LastScheduleTime   *time.Time `json:"lastScheduleTime,omitempty"`
	LastSuccessfulTime *time.Time `json:"lastSuccessfulTime,omitempty"`
	// LastJob is the newest Job the CronJob still owns. Nil with no
	// LastScheduleTime means the schedule has never run, which is not an
	// error. Nil with a LastScheduleTime means the Job was already cleaned
	// up (history limit or ttlSecondsAfterFinished).
	LastJob *JobStatus `json:"lastJob,omitempty"`
}

// JobStatus is the outcome of one Job run by a CronJob.
type JobStatus struct {
	Name       string     `json:"name"`
	Outcome    string     `json:"outcome"` // "running" | "succeeded" | "failed"
	Reason     string     `json:"reason,omitempty"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
}

// kubeStatusStore is the subset of *store.Store the status reader depends on.
type kubeStatusStore interface {
	GetCurrentDeployments(ctx context.Context) ([]store.CurrentDeployment, error)
	UpdateKubernetesStatus(ctx context.Context, appID, statusJSON string) error
}

// StatusReader periodically reads each live app's Deployment or CronJob and
// maintains app_observed_status.kubernetes_status.
type StatusReader struct {
	client kubernetes.Interface
	store  kubeStatusStore
	log    *zap.Logger

	// lastWritten debounces DB writes: an unchanged status is only written
	// again once healthRewriteInterval old, the same freshness rule as
	// runtime health. Only used from Run's goroutine.
	lastWritten map[string]writtenVerdict
}

// NewStatusReader creates a StatusReader. Call Run to start it.
func NewStatusReader(client kubernetes.Interface, s *store.Store, log *zap.Logger) *StatusReader {
	return &StatusReader{
		client:      client,
		store:       s,
		log:         log,
		lastWritten: make(map[string]writtenVerdict),
	}
}

// Run blocks until ctx is cancelled, reading every live app's workload
// status once per statusReadInterval.
func (r *StatusReader) Run(ctx context.Context) error {
	ticker := time.NewTicker(statusReadInterval)
	defer ticker.Stop()
	for {
		if err := r.readAll(ctx); err != nil {
			r.log.Warn("kubernetes status read failed", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (r *StatusReader) readAll(ctx context.Context) error {
	deps, err := r.store.GetCurrentDeployments(ctx)
	if err != nil {
		return fmt.Errorf("get current deployments: %w", err)
	}

	live := make(map[string]bool, len(deps))
	for _, d := range deps {
		live[d.AppID] = true
		status, err := r.readApp(ctx, d)
		if err != nil {
			// Leave the stored status alone: it goes stale and the API then
			// reports it as unknown, instead of guessing from a failed read.
			r.log.Debug("read kubernetes status failed", zap.String("app_id", d.AppID), zap.Error(err))
			continue
		}
		r.write(ctx, d.AppID, status)
	}
	// Drop debounce state for apps that are no longer live.
	for appID := range r.lastWritten {
		if !live[appID] {
			delete(r.lastWritten, appID)
		}
	}
	return nil
}

func (r *StatusReader) readApp(ctx context.Context, d store.CurrentDeployment) (KubernetesStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, statusReadTimeout)
	defer cancel()
	ns := libk8s.AppNamespace(d.ProjectID, d.ProjectSlug)
	if d.DeploymentType == "cronjob" {
		return r.readCronJob(ctx, ns, d.AppSlug)
	}
	return r.readDeployment(ctx, ns, d.AppSlug)
}

func (r *StatusReader) readDeployment(ctx context.Context, ns, name string) (KubernetesStatus, error) {
	dep, err := r.client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return KubernetesStatus{Workload: WorkloadMissing}, nil
	}
	if err != nil {
		return KubernetesStatus{}, fmt.Errorf("get deployment: %w", err)
	}
	desired := int32(1)
	if dep.Spec.Replicas != nil {
		desired = *dep.Spec.Replicas
	}
	pods, err := r.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: libk8s.AppLabelSelector(name)})
	if err != nil {
		return KubernetesStatus{}, fmt.Errorf("list pods: %w", err)
	}
	return KubernetesStatus{
		Workload: WorkloadPresent,
		Replicas: &ReplicaStatus{
			Desired:   desired,
			Ready:     dep.Status.ReadyReplicas,
			Available: dep.Status.AvailableReplicas,
			Updated:   dep.Status.UpdatedReplicas,
		},
		Serving: servingDeployments(pods.Items),
	}, nil
}

// servingDeployments counts the ready pods of each deployment, skipping pods
// that are being deleted, which stop serving once their endpoints go.
func servingDeployments(pods []corev1.Pod) []ServingDeployment {
	ready := map[string]int32{}
	for i := range pods {
		p := &pods[i]
		id := p.Labels[libk8s.LabelDeployment]
		if id == "" || p.DeletionTimestamp != nil || !podReady(p) {
			continue
		}
		ready[id]++
	}
	out := make([]ServingDeployment, 0, len(ready))
	for id, n := range ready {
		out = append(out, ServingDeployment{DeploymentID: id, ReadyPods: n})
	}
	slices.SortFunc(out, func(a, b ServingDeployment) int {
		if c := cmp.Compare(b.ReadyPods, a.ReadyPods); c != 0 {
			return c
		}
		return strings.Compare(a.DeploymentID, b.DeploymentID)
	})
	return out
}

func (r *StatusReader) readCronJob(ctx context.Context, ns, name string) (KubernetesStatus, error) {
	cj, err := r.client.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return KubernetesStatus{Workload: WorkloadMissing}, nil
	}
	if err != nil {
		return KubernetesStatus{}, fmt.Errorf("get cronjob: %w", err)
	}
	jobs, err := r.client.BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return KubernetesStatus{}, fmt.Errorf("list jobs: %w", err)
	}

	status := &CronJobStatus{
		Suspended:          cj.Spec.Suspend != nil && *cj.Spec.Suspend,
		LastScheduleTime:   timePtr(cj.Status.LastScheduleTime),
		LastSuccessfulTime: timePtr(cj.Status.LastSuccessfulTime),
	}
	if newest := newestOwnedJob(jobs.Items, cj); newest != nil {
		status.LastJob = jobStatus(newest)
	}
	return KubernetesStatus{Workload: WorkloadPresent, CronJob: status}, nil
}

// newestOwnedJob returns the most recently created Job owned by cj, matched by
// UID so a Job left by an earlier CronJob of the same name is never counted.
func newestOwnedJob(jobs []batchv1.Job, cj *batchv1.CronJob) *batchv1.Job {
	var newest *batchv1.Job
	for i := range jobs {
		j := &jobs[i]
		owned := false
		for _, ref := range j.OwnerReferences {
			if ref.Kind == "CronJob" && ref.UID == cj.UID {
				owned = true
				break
			}
		}
		if owned && (newest == nil || newest.CreationTimestamp.Before(&j.CreationTimestamp)) {
			newest = j
		}
	}
	return newest
}

func jobStatus(j *batchv1.Job) *JobStatus {
	s := &JobStatus{
		Name:       j.Name,
		Outcome:    JobRunning,
		StartedAt:  timePtr(j.Status.StartTime),
		FinishedAt: timePtr(j.Status.CompletionTime),
	}
	for _, c := range j.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			s.Outcome = JobSucceeded
		case batchv1.JobFailed:
			s.Outcome = JobFailed
			s.Reason = c.Reason
			if s.FinishedAt == nil {
				s.FinishedAt = timePtr(&c.LastTransitionTime)
			}
		}
	}
	return s
}

func timePtr(t *metav1.Time) *time.Time {
	if t == nil || t.IsZero() {
		return nil
	}
	v := t.UTC()
	return &v
}

func (r *StatusReader) write(ctx context.Context, appID string, status KubernetesStatus) {
	b, err := json.Marshal(status)
	if err != nil {
		r.log.Warn("marshal kubernetes status failed", zap.String("app_id", appID), zap.Error(err))
		return
	}
	now := time.Now()
	last, written := r.lastWritten[appID]
	if written && last.verdict == string(b) && now.Sub(last.at) < healthRewriteInterval {
		return
	}
	if err := r.store.UpdateKubernetesStatus(ctx, appID, string(b)); err != nil {
		r.log.Warn("update kubernetes status failed", zap.String("app_id", appID), zap.Error(err))
		return
	}
	r.lastWritten[appID] = writtenVerdict{verdict: string(b), at: now}
}
