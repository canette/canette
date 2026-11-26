package controller

import (
	"context"
	"errors"
	"time"

	"go.uber.org/zap"

	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
	"canette.dev/lib/failpoint"
)

// One worker per app brings the app's resources in line with its intent
// (#354). It holds the app's lease while it runs, so no other worker acts on
// the app, and makes every Kubernetes change through store.Fence, which
// re-checks the intent under a lock first. Waiting for a rollout happens
// outside the lock, so a Stop or a newer deploy is accepted at once and picked
// up on the next rollout poll.

// heartbeatInterval is how often a worker renews its app's lease. Well within
// store.AppLeaseTTL, so a few failed writes in a row don't lose the lease.
const heartbeatInterval = 15 * time.Second

// maxRounds bounds how many times one worker re-reads a changing intent
// before it gives the app back to the poll loop.
const maxRounds = 10

// releaseTimeout bounds the writes a worker makes after its context ended:
// giving up the lease, or recording a failure.
const releaseTimeout = 5 * time.Second

// runApp works on one claimed app until its intent is reconciled, then gives
// up the lease. On shutdown it gives the lease up without finishing, so the
// next controller resumes the work.
func (c *Controller) runApp(ctx context.Context, lease store.Lease) {
	log := c.log.With(zap.String("app_id", lease.AppID))
	ctx, lost, stop := c.keepLease(ctx, log, lease)
	defer stop()

	for range maxRounds {
		in, err := c.store.ReadIntent(ctx, lease.AppID)
		if err != nil {
			if ctx.Err() == nil {
				log.Warn("read intent failed", zap.Error(err))
			}
			break
		}
		if in == nil || !in.NeedsWork() {
			break // deleted (the app cleanup queue takes over), or done
		}
		if !c.step(ctx, log, lease, in) {
			break
		}
	}

	if lost() {
		return
	}
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	if err := c.store.Release(releaseCtx, lease); err != nil {
		log.Warn("release app lease failed", zap.Error(err))
	}
}

// step makes one change towards the intent. It reports whether the intent
// should be read again: after a change that may leave more to do, or when the
// intent moved on during the change.
func (c *Controller) step(ctx context.Context, log *zap.Logger, lease store.Lease, in *store.Intent) bool {
	if in.Desired == "stopped" {
		return c.stopApp(ctx, log, lease, in)
	}
	if in.Target == nil {
		return c.markReconciled(ctx, log, lease, in.Generation)
	}
	switch in.TargetStatus {
	case "pending_deployment", "deploying", "live":
		return c.deploy(ctx, log, lease, in)
	default:
		// failed, superseded or stopped: nothing to roll out.
		return c.markReconciled(ctx, log, lease, in.Generation)
	}
}

// stopApp deletes the app's workload of either type, Service, HTTPRoute, PDB
// and ConfigMaps. The namespace, Secrets and PVCs stay: PVCs hold user data
// and survive a Stop, and are reclaimed when the app is deleted (DeleteApp) or
// with the project's namespace.
func (c *Controller) stopApp(ctx context.Context, log *zap.Logger, lease store.Lease, in *store.Intent) bool {
	log = log.With(zap.String("app", in.AppSlug), zap.String("project", in.ProjectSlug))
	ns := k8sres.AppNamespace(in.ProjectID, in.ProjectSlug)
	err := c.store.Fence(ctx, lease, in.Generation, func(ctx context.Context) error {
		if err := k8sres.TeardownApp(ctx, c.dynClient, ns, in.AppSlug); err != nil {
			return err
		}
		return k8sres.TeardownCronJob(ctx, c.dynClient, ns, in.AppSlug)
	})
	if again, handled := c.fenceOutcome(ctx, log, err); handled {
		return again
	}
	if err != nil {
		// Idempotent: the app still needs work, so a later poll retries.
		log.Warn("teardown error", zap.Error(err))
		return false
	}

	failpoint.Hit("after-teardown-delete")

	if err := c.store.FinishStop(ctx, lease, in.Generation); err != nil {
		if !errors.Is(err, store.ErrLeaseLost) {
			log.Warn("record teardown error", zap.Error(err))
		}
		return false
	}
	log.Info("teardown complete")
	return true
}

func (c *Controller) markReconciled(ctx context.Context, log *zap.Logger, lease store.Lease, generation int64) bool {
	if err := c.store.MarkReconciled(ctx, lease, generation); err != nil && !errors.Is(err, store.ErrLeaseLost) {
		log.Warn("mark reconciled error", zap.Error(err))
	}
	return false
}

// fenceOutcome handles the results of store.Fence that end the step: the
// intent moved on (read it again), the lease was lost or the controller is
// shutting down (stop). handled is false for success and for errors of the
// step itself, which the caller handles.
func (c *Controller) fenceOutcome(ctx context.Context, log *zap.Logger, err error) (again, handled bool) {
	switch {
	case errors.Is(err, store.ErrIntentChanged):
		log.Info("intent changed before the change was made; reading it again")
		return true, true
	case errors.Is(err, store.ErrLeaseLost):
		log.Warn("app lease lost; another worker took over")
		return false, true
	case err != nil && ctx.Err() != nil:
		return false, true // shutting down: the next controller resumes
	}
	return false, false
}

// keepLease renews the lease every heartbeatInterval. The returned context
// is cancelled when the lease is lost, which stops the worker before its next
// change, and lost then reports true. stop ends the heartbeat.
func (c *Controller) keepLease(ctx context.Context, log *zap.Logger, lease store.Lease) (_ context.Context, lost func() bool, stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	lostCh := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				err := c.store.Heartbeat(ctx, lease)
				if errors.Is(err, store.ErrLeaseLost) {
					log.Warn("app lease lost; stopping work on the app")
					close(lostCh)
					cancel()
					return
				}
				if err != nil && ctx.Err() == nil {
					log.Warn("app lease heartbeat failed", zap.Error(err))
				}
			}
		}
	}()
	lost = func() bool {
		select {
		case <-lostCh:
			return true
		default:
			return false
		}
	}
	return ctx, lost, func() {
		cancel()
		<-done
	}
}
