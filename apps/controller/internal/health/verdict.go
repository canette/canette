// Package health watches Kubernetes pods for canette-managed apps in the
// background and derives a "runtime health" verdict — whether the app's
// current pod(s) are actually healthy right now — independent of whether the
// app's most recent deploy operation succeeded (deployments.status). Nothing
// else in the controller ever revisits a deployment once it reaches
// status='live' (see internal/controller/reconcile.go); this package closes
// that gap.
package health

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Runtime health verdict values, mirrored in the apps.runtime_health DB check
// constraint (apps/api/migrations/000016_app_runtime_health.up.sql).
const (
	HealthHealthy   = "healthy"
	HealthUnhealthy = "unhealthy"
	HealthUnknown   = "unknown"
)

const (
	// restartWindow/restartThreshold: a single isolated restart is normal
	// self-healing (e.g. a transient blip) and must never be flagged on its
	// own; sustained restarting within a short window is a real problem.
	restartWindow    = 5 * time.Minute
	restartThreshold = 3

	// notReadyGrace is how long PodReady=false must persist — with no
	// crash/backoff signal already explaining it — before being flagged.
	// This is what makes a configured readinessProbe (see canette.yaml
	// healthcheck wiring) worth having: a hung-but-not-crashing app becomes
	// detectable instead of looking identical to a healthy one.
	notReadyGrace = 60 * time.Second

	// noPodsGrace is how long an app can have zero pods for its current
	// deployment before being reported unhealthy — covers normal pod
	// rescheduling/eviction windows without a false alarm.
	noPodsGrace = 30 * time.Second
)

// podEvaluation is the per-pod result of evaluatePod.
type podEvaluation struct {
	Healthy bool
	Reason  string // empty when Healthy
}

// restartTracking is the in-memory, per-pod state the watcher maintains
// across informer events. Never persisted — only the derived verdict is.
type restartTracking struct {
	lastRestartCount int32
	restarts         []time.Time // restart timestamps, pruned to restartWindow
	notReadySince    time.Time   // zero value means "currently ready"
}

// observe updates tracking state from a fresh pod snapshot.
func (t *restartTracking) observe(pod *corev1.Pod, now time.Time) {
	count := totalRestartCount(pod)
	if count > t.lastRestartCount {
		t.restarts = append(t.restarts, now)
	}
	t.lastRestartCount = count

	cutoff := now.Add(-restartWindow)
	kept := t.restarts[:0]
	for _, ts := range t.restarts {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	t.restarts = kept

	if podReady(pod) {
		t.notReadySince = time.Time{}
	} else if t.notReadySince.IsZero() {
		t.notReadySince = now
	}
}

func totalRestartCount(pod *corev1.Pod) int32 {
	var total int32
	for _, cs := range pod.Status.ContainerStatuses {
		total += cs.RestartCount
	}
	return total
}

func podReady(pod *corev1.Pod) bool {
	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.PodReady {
			return cond.Status == corev1.ConditionTrue
		}
	}
	return false
}

// evaluatePod derives a health verdict for one pod from its container
// statuses and restart tracking, in priority order (first match wins):
//
//  1. A container currently backing off from repeated restarts
//     (CrashLoopBackOff/ImagePullBackOff/ErrImagePull) — zero-config,
//     immediate, works for every app.
//  2. A container's most recent exit was a failure (nonzero exit code) and
//     it hasn't recovered — this is what makes a pod's FIRST crash visible:
//     kubelet only enters backoff (case 1) after several restarts, so a pod
//     that has crashed once and not yet restarted shows up only as
//     Terminated.
//  3. Sustained restarts within the tracking window.
//  4. Not Ready for longer than the grace period, with none of the above
//     already explaining it.
//  5. Otherwise healthy.
func evaluatePod(pod *corev1.Pod, tracking *restartTracking, now time.Time) podEvaluation {
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull":
				return podEvaluation{Reason: cs.State.Waiting.Reason}
			}
		}
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
			reason := t.Reason
			if reason == "" {
				reason = "Error"
			}
			return podEvaluation{Reason: fmt.Sprintf("%s (exit %d)", reason, t.ExitCode)}
		}
	}
	if tracking != nil && len(tracking.restarts) >= restartThreshold {
		return podEvaluation{Reason: "restarting repeatedly"}
	}
	if tracking != nil && !tracking.notReadySince.IsZero() && now.Sub(tracking.notReadySince) > notReadyGrace {
		return podEvaluation{Reason: "readiness probe failing"}
	}
	return podEvaluation{Healthy: true}
}

// aggregateAppHealth combines per-pod evaluations for one app's current
// deployment into a single verdict: unhealthy if any pod is unhealthy
// (pessimistic — per-pod detail is left to the UI's metrics panel, not this
// summary signal). An app with zero pods is only reported unhealthy once
// noPodsSince has aged past noPodsGrace, to avoid a false alarm during normal
// pod rescheduling.
func aggregateAppHealth(evals []podEvaluation, noPodsSince, now time.Time) (health, reason string) {
	if len(evals) == 0 {
		if noPodsSince.IsZero() || now.Sub(noPodsSince) < noPodsGrace {
			return HealthUnknown, ""
		}
		return HealthUnhealthy, "no running pods"
	}
	for _, e := range evals {
		if !e.Healthy {
			return HealthUnhealthy, e.Reason
		}
	}
	return HealthHealthy, ""
}
