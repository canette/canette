package controller

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"

	"canette.dev/controller/internal/config"
	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
	"canette.dev/lib/crypto"
)

// rolloutTimeout bounds the wait for a rollout. K8s progressDeadlineSeconds
// defaults to 600s (10min); the timeout must exceed that so we see the real
// ProgressDeadlineExceeded condition rather than timing out first.
const rolloutTimeout = 12 * time.Minute

// deploy rolls out the intent's target: claims it if it is still waiting,
// applies its resources inside a fenced step and waits for the rollout. An
// attempt that is already deploying (after a crash) or live (a repair) is
// applied again, which server-side apply makes safe.
func (c *Controller) deploy(ctx context.Context, log *zap.Logger, lease store.Lease, in *store.Intent) bool {
	dep := *in.Target
	generation := in.Generation
	log = log.With(
		zap.String("deployment", dep.ID),
		zap.String("app", dep.AppSlug),
		zap.String("project", dep.ProjectSlug),
	)
	if in.TargetErr != nil {
		c.failDeploy(ctx, log, lease, generation, dep.ID, in.TargetErr)
		return false
	}
	if in.TargetStatus == "pending_deployment" {
		started, err := c.store.StartDeploying(ctx, dep.ID)
		if err != nil {
			log.Warn("start deploying error", zap.Error(err))
			return false
		}
		if !started {
			return true // swept or changed since the intent was read
		}
	}

	res, deployCfg, appCfg, err := c.prepare(ctx, log, dep)
	if err != nil {
		c.failDeploy(ctx, log, lease, generation, dep.ID, err)
		return false
	}

	appNS := k8sres.AppNamespace(dep.ProjectID, dep.ProjectSlug)
	c.appendLog(ctx, log, dep.ID, "controller", "Applying Kubernetes resources...")
	var warnings *k8sres.WarningCollector
	var applied k8sres.AppliedWorkload
	err = c.store.Fence(ctx, lease, generation, func(ctx context.Context) error {
		var applyCtx context.Context
		applyCtx, warnings = k8sres.WithWarningCollector(ctx)
		var err error
		applied, err = c.applyAll(applyCtx, c.dynClient, res)
		return err
	})
	if errors.Is(err, store.ErrIntentChanged) {
		c.appendLog(ctx, log, dep.ID, "controller", "The app's intent changed before this deployment was applied")
		return c.retire(ctx, log, dep.AppID, dep.ID)
	}
	if again, handled := c.fenceOutcome(ctx, log, err); handled {
		return again
	}
	if err != nil {
		c.failDeploy(ctx, log, lease, generation, dep.ID, fmt.Errorf("apply resources: %w", err))
		return false
	}
	c.appendLog(ctx, log, dep.ID, "controller", "Resources applied successfully")
	workload := store.Workload{UID: applied.UID, Generation: applied.Generation}
	if err := c.store.SetAppliedWorkload(ctx, dep.ID, workload); err != nil {
		log.Warn("failed to record the applied workload", zap.Error(err))
	}
	if psa := warnings.PodSecurityWarnings(); len(psa) > 0 {
		enforce := c.cfg.NamespacePolicy.PodSecurity.Enforce
		for _, line := range podSecurityLogLines(psa, enforce, appCfg.Security != nil) {
			c.appendLog(ctx, log, dep.ID, "controller", line)
		}
	}

	// CronJobs have no Deployment to roll out.
	var livePodName string
	if !deployCfg.IsCronJob {
		r := c.waitRollout(ctx, log, dep, applied, &generation)
		switch {
		case r.interrupted:
			return r.again
		case r.err != nil:
			c.failDeploy(ctx, log, lease, generation, dep.ID, r.err)
			return false
		}
		livePodName = r.podName
		workload.Revision = r.revision
	}

	var liveURL sql.NullString
	if !deployCfg.IsCronJob && !deployCfg.SkipHTTPRoute {
		liveURL = sql.NullString{String: fmt.Sprintf("https://%s-%s.%s", dep.AppSlug, dep.ProjectSlug, c.cfg.ClusterDomain), Valid: true}
	}
	if err := c.store.FinishDeploy(ctx, lease, generation, dep.ID, liveURL, workload); err != nil {
		if errors.Is(err, store.ErrNotDeploying) {
			// Superseded or stopped meanwhile: leave its status alone and
			// don't publish a URL for it.
			log.Warn("rollout finished, but the deployment is no longer deploying; not marking it live")
			c.appendLog(ctx, log, dep.ID, "controller",
				"Rollout finished, but this deployment was no longer in progress, so it was not marked live")
			return true
		}
		if !errors.Is(err, store.ErrLeaseLost) {
			log.Error("record rollout success failed", zap.Error(err))
		}
		return false
	}
	if c.onDeployLive != nil {
		c.onDeployLive()
	}

	switch {
	case deployCfg.IsCronJob:
		c.appendLog(ctx, log, dep.ID, "controller", fmt.Sprintf("CronJob scheduled with expression: %s", deployCfg.Schedule))
		log.Info("cronjob deployment live", zap.String("schedule", deployCfg.Schedule))
	case deployCfg.SkipHTTPRoute:
		clusterDNS := fmt.Sprintf("%s.%s.svc.cluster.local", dep.AppSlug, appNS)
		msg := fmt.Sprintf("Private deployment live. Reachable at %s", clusterDNS)
		if livePodName != "" {
			msg = fmt.Sprintf("%s (pod %s)", msg, livePodName)
		}
		c.appendLog(ctx, log, dep.ID, "controller", msg)
		log.Info("deployment live (private)", zap.String("cluster_dns", clusterDNS), zap.String("pod", livePodName))
	default:
		msg := fmt.Sprintf("Deployment live at %s", liveURL.String)
		if livePodName != "" {
			msg = fmt.Sprintf("%s (pod %s)", msg, livePodName)
		}
		c.appendLog(ctx, log, dep.ID, "controller", msg)
		log.Info("deployment live", zap.String("url", liveURL.String), zap.String("pod", livePodName))
	}
	return true
}

// rolloutResult is how waitRollout ended. interrupted means the wait was
// given up without a verdict (the app is needed for something else, the
// lease was lost, or shutdown), and again whether to read the intent again.
// Otherwise err is nil for a successful rollout.
type rolloutResult struct {
	interrupted bool
	again       bool
	err         error
	podName     string
	revision    string
}

// waitRollout polls the rollout of the workload the apply wrote until it
// finishes, checking the intent on every poll:
//
//   - Stop: give up the wait, the next step tears the app down.
//   - A newer target that is ready to roll out: supersede this attempt and
//     give up the wait, the next step rolls the newer one out.
//   - A newer target still being built: keep waiting, because this attempt is
//     what will serve until the newer one is ready.
//   - The same target at a newer generation (a repair): carry on, counting
//     the work as done up to the newer generation.
func (c *Controller) waitRollout(ctx context.Context, log *zap.Logger, dep store.DeployingDeployment, applied k8sres.AppliedWorkload, generation *int64) rolloutResult {
	appNS := k8sres.AppNamespace(dep.ProjectID, dep.ProjectSlug)
	deadline := time.Now().Add(rolloutTimeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return rolloutResult{interrupted: true}
		}
		status, err := c.checkRollout(ctx, c.client, appNS, dep.AppSlug, dep.ID, applied)
		if err != nil {
			log.Warn("check rollout error", zap.Error(err))
		} else {
			c.appendLog(ctx, log, dep.ID, "controller", status.Message)
			if status.Done {
				if status.Succeeded {
					return rolloutResult{podName: status.PodName, revision: status.Revision}
				}
				return rolloutResult{err: fmt.Errorf("rollout failed: %s", status.Message)}
			}
		}

		cur, err := c.store.ReadIntent(ctx, dep.AppID)
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return rolloutResult{interrupted: true}
			}
			log.Warn("read intent during rollout failed", zap.Error(err))
		case cur == nil:
			return rolloutResult{interrupted: true} // the app was deleted
		case cur.Desired == "stopped":
			c.appendLog(ctx, log, dep.ID, "controller", "The app was stopped during the rollout")
			return rolloutResult{interrupted: true, again: true}
		case cur.Target != nil && cur.Target.ID == dep.ID:
			*generation = cur.Generation
		case cur.Target != nil && cur.TargetStatus == "pending_deployment":
			c.appendLog(ctx, log, dep.ID, "controller", "A newer deployment is ready, so this one is superseded")
			if err := c.store.Supersede(ctx, dep.ID); err != nil {
				log.Warn("supersede error", zap.Error(err))
			}
			return rolloutResult{interrupted: true, again: true}
		}

		select {
		case <-ctx.Done():
			return rolloutResult{interrupted: true}
		case <-time.After(c.rolloutPollInterval):
		}
	}
	return rolloutResult{err: fmt.Errorf("rollout timed out after %s", rolloutTimeout)}
}

// retire handles an attempt whose fenced apply was refused because the intent
// moved on: unless the attempt is still the target, it is superseded. A Stop
// leaves it to the stop step, which records it as stopped.
func (c *Controller) retire(ctx context.Context, log *zap.Logger, appID, deploymentID string) bool {
	in, err := c.store.ReadIntent(ctx, appID)
	if err != nil {
		log.Warn("read intent failed", zap.Error(err))
		return false
	}
	if in == nil {
		return false
	}
	if in.Desired == "running" && (in.Target == nil || in.Target.ID != deploymentID) {
		if err := c.store.Supersede(ctx, deploymentID); err != nil {
			log.Warn("supersede error", zap.Error(err))
		}
	}
	return true
}

// failDeploy records the attempt's failure. A failure caused by shutdown is
// not recorded: the lease is given up and the next controller resumes.
func (c *Controller) failDeploy(ctx context.Context, log *zap.Logger, lease store.Lease, generation int64, deploymentID string, cause error) {
	if ctx.Err() != nil {
		return
	}
	log.Error("reconcile failed", zap.Error(cause))
	if err := c.store.FailDeploy(ctx, lease, generation, deploymentID, cause.Error()); err != nil && !errors.Is(err, store.ErrLeaseLost) {
		log.Error("failed to mark deployment failed", zap.Error(err))
	}
}

// prepare reads the attempt's config and secrets and builds its resources,
// storing the redacted manifest before anything is applied, so it survives a
// failed apply.
func (c *Controller) prepare(ctx context.Context, log *zap.Logger, dep store.DeployingDeployment) (k8sres.AppResources, k8sres.DeployConfig, *store.AppConfig, error) {
	var none k8sres.AppResources
	// 1. Fetch app config.
	appCfg, cfgErr := c.store.GetAppConfig(ctx, dep)
	// An invalid security block fails the deployment instead of deploying
	// without the hardening the user asked for.
	var secErr *config.SecurityError
	if errors.As(cfgErr, &secErr) {
		return none, k8sres.DeployConfig{}, nil, fmt.Errorf("invalid canette.yaml: %s", secErr.Msg)
	}
	for _, w := range appCfg.ConfigWarnings {
		c.appendLog(ctx, log, dep.ID, "controller", "Warning: canette.yaml "+w)
	}
	if cfgErr != nil {
		// canette.yaml is invalid — deployment continues with snapshot defaults.
		msg := fmt.Sprintf("Warning: canette.yaml could not be parsed (%s); using defaults", cfgErr)
		log.Warn("invalid canette.yaml, using defaults", zap.Error(cfgErr))
		c.appendLog(ctx, log, dep.ID, "controller", msg)
	}

	// 2. Fetch and decrypt secrets.
	secrets, err := c.store.GetSecrets(ctx, dep.AppID)
	if err != nil {
		return none, k8sres.DeployConfig{}, nil, fmt.Errorf("get secrets: %w", err)
	}
	secretData := make(map[string][]byte, len(secrets))
	for _, sec := range secrets {
		decrypted, err := crypto.Decrypt(sec.EncryptedValue, c.cryptoKey)
		if err != nil {
			log.Error("failed to decrypt secret", zap.String("key", sec.Key), zap.Error(err))
			return none, k8sres.DeployConfig{}, nil, fmt.Errorf("failed to decrypt app secrets")
		}
		secretData[sec.Key] = []byte(decrypted)
	}

	// 3. Fetch imagePullSecret data if enabled.
	var imagePullSecretName string
	var imagePullSecretData []byte

	if c.cfg.ImagePullSecretsEnabled && c.cfg.RegistryAuthConfigFile != "" {
		// Determine if we need registry credentials based on image source
		needsRegistryCreds := false

		switch appCfg.SourceType {
		case "git":
			needsRegistryCreds = true
		case "image":
			needsRegistryCreds = strings.HasPrefix(appCfg.ImageDigest, c.cfg.RegistryHost)
		}

		if needsRegistryCreds {
			// Read the registry auth config from mounted file
			dockerConfigJSON, err := os.ReadFile(c.cfg.RegistryAuthConfigFile)
			if err != nil {
				log.Warn("failed to read registry auth config file", zap.Error(err))
				// Non-fatal: continue without imagePullSecret (might still work if nodes have access)
			} else {
				imagePullSecretName = "canette-registry-creds"
				imagePullSecretData = dockerConfigJSON
				log.Debug("imagePullSecret enabled", zap.String("secret_name", imagePullSecretName))
			}
		}
	}

	// 4. Build K8s resources.
	isCronJob := appCfg.DeploymentType == "cronjob"
	skipHTTPRoute := appCfg.DeploymentType == "private"
	if !isCronJob {
		if runtimeCfg, err2 := config.ParseRuntimeConfig(dep.CanetteConfig); err2 == nil {
			if runtimeCfg.Ingress.Enabled != nil && !*runtimeCfg.Ingress.Enabled {
				skipHTTPRoute = true
			}
		}
	}
	deployCfg := c.buildDeployConfig(appCfg, secretData, imagePullSecretName, imagePullSecretData, skipHTTPRoute, dep.ID)
	res := k8sres.BuildResources(deployCfg)

	// 5. Render and store manifest (before applying — preserves intent even if apply fails).
	manifest, err := k8sres.RenderManifest(res)
	if err != nil {
		log.Warn("failed to render manifest", zap.Error(err))
	} else {
		if err := c.store.SetAppliedManifest(ctx, dep.ID, manifest); err != nil {
			log.Warn("failed to store manifest", zap.Error(err))
		}
	}
	return res, deployCfg, appCfg, nil
}

func (c *Controller) appendLog(ctx context.Context, log *zap.Logger, deploymentID, stream, line string) {
	if err := c.store.AppendLog(ctx, deploymentID, stream, line); err != nil {
		log.Warn("failed to write controller log", zap.Error(err))
	}
}
