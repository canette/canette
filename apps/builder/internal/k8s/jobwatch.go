package k8s

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
)

// watchRetryDelay is how long WaitForJob waits before watching again after
// the watch closed or failed, so a server that keeps closing it at once isn't
// hammered. A variable so tests can shorten it.
var watchRetryDelay = time.Second

// WaitForJob watches a Job until it finishes and reports whether it
// succeeded. A watch that closes is re-established from the last seen
// resourceVersion. After a watch error (e.g. 410 Gone, when that
// resourceVersion has expired) the Job is read again: a finished Job returns
// its outcome, a running one is watched again from its current
// resourceVersion. A Job that is deleted before it finishes is an error.
func WaitForJob(ctx context.Context, client kubernetes.Interface, namespace, name string, log *zap.Logger) (bool, error) {
	jobs := client.BatchV1().Jobs(namespace)
	fieldSel := fields.OneTermEqualSelector("metadata.name", name).String()
	var resourceVersion string
	for {
		watcher, err := jobs.Watch(ctx, metav1.ListOptions{
			FieldSelector:   fieldSel,
			ResourceVersion: resourceVersion,
		})
		var res watchResult
		if err == nil {
			res = drainJobWatch(ctx, log, watcher)
			watcher.Stop()
		} else if apierrors.IsGone(err) || apierrors.IsResourceExpired(err) {
			res = watchResult{kind: watchFailed, err: err}
		} else {
			return false, fmt.Errorf("watch job: %w", err)
		}

		switch res.kind {
		case watchCancelled:
			return false, ctx.Err()
		case watchFinished:
			return res.succeeded, nil
		case watchDeleted:
			return false, fmt.Errorf("job %s was deleted before it finished", name)
		case watchClosed:
			// Transient (apiserver restart, watch timeout). Resume from the last
			// seen resourceVersion.
			if res.resourceVersion != "" {
				resourceVersion = res.resourceVersion
			}
			log.Warn("job watch closed, re-establishing", zap.String("job", name))
		case watchFailed:
			log.Warn("job watch failed, reading the job again", zap.String("job", name), zap.Error(res.err))
			job, err := jobs.Get(ctx, name, metav1.GetOptions{})
			if apierrors.IsNotFound(err) {
				return false, fmt.Errorf("job %s no longer exists", name)
			}
			if err != nil {
				return false, fmt.Errorf("get job after watch error: %w", err)
			}
			if finished, succeeded := jobOutcome(log, job); finished {
				return succeeded, nil
			}
			resourceVersion = job.ResourceVersion
		}

		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(watchRetryDelay):
		}
	}
}

type watchResultKind int

const (
	watchClosed    watchResultKind = iota // channel closed, no outcome yet
	watchFailed                           // watch.Error event
	watchFinished                         // the Job finished
	watchDeleted                          // the Job was deleted before it finished
	watchCancelled                        // ctx ended
)

type watchResult struct {
	kind            watchResultKind
	succeeded       bool   // watchFinished only
	resourceVersion string // last seen
	err             error  // watchFailed only
}

// drainJobWatch reads events until the Job finishes, is deleted, the watch
// fails or closes, or ctx ends. The initial event of a watch started without a
// resourceVersion carries the Job's current state, so a Job that finished
// before the watch started is still seen.
func drainJobWatch(ctx context.Context, log *zap.Logger, watcher watch.Interface) watchResult {
	var res watchResult
	for {
		select {
		case <-ctx.Done():
			res.kind = watchCancelled
			return res
		case event, ok := <-watcher.ResultChan():
			if !ok {
				res.kind = watchClosed
				return res
			}
			if event.Type == watch.Error {
				res.kind = watchFailed
				res.err = apierrors.FromObject(event.Object)
				return res
			}
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			if job.ResourceVersion != "" {
				res.resourceVersion = job.ResourceVersion
			}
			// A Deleted event carries the Job's last state, which may be final.
			if finished, succeeded := jobOutcome(log, job); finished {
				res.kind = watchFinished
				res.succeeded = succeeded
				return res
			}
			if event.Type == watch.Deleted {
				res.kind = watchDeleted
				return res
			}
		}
	}
}

// jobOutcome reports whether the Job has finished and, if so, whether it
// succeeded.
func jobOutcome(log *zap.Logger, job *batchv1.Job) (finished, succeeded bool) {
	if job.Status.Succeeded > 0 {
		log.Info("job succeeded", zap.String("job", job.Name))
		return true, true
	}
	for _, cond := range job.Status.Conditions {
		if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
			log.Warn("job failed", zap.String("job", job.Name),
				zap.String("reason", cond.Reason), zap.String("message", cond.Message))
			return true, false
		}
	}
	return false, false
}
