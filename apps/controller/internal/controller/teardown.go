package controller

import (
	"context"

	"go.uber.org/zap"

	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
)

// runTeardown deletes the K8s resources for a stopped app and clears its live URL.
// Errors are logged but not fatal — the operation is idempotent and will retry next poll.
func (c *Controller) runTeardown(ctx context.Context, dep store.StoppedDeployment) {
	log := c.log.With(
		zap.String("deployment_id", dep.ID),
		zap.String("app", dep.AppSlug),
		zap.String("project", dep.ProjectSlug),
	)

	appNS := k8sres.AppNamespace(dep.ProjectID, dep.ProjectSlug)
	if err := k8sres.TeardownApp(ctx, c.dynClient, appNS, dep.AppSlug); err != nil {
		log.Warn("teardown error", zap.Error(err))
		// non-fatal: idempotent, will retry next poll
		return
	}

	if err := c.store.ClearAppLiveURL(ctx, dep.AppID); err != nil {
		log.Warn("clear live url error", zap.Error(err))
	}

	// Clear applied_manifest so ClaimTeardown won't re-process this deployment.
	if err := c.store.MarkTornDown(ctx, dep.ID); err != nil {
		log.Warn("mark torn down error", zap.Error(err))
	}

	log.Info("teardown complete")
}
