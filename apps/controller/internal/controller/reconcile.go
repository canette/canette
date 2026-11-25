package controller

import (
	"context"
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

func (c *Controller) reconcile(ctx context.Context, dep store.DeployingDeployment) {
	log := c.log.With(
		zap.String("deployment", dep.ID),
		zap.String("app", dep.AppSlug),
		zap.String("project", dep.ProjectSlug),
	)

	stopHeartbeat := c.startHeartbeat(ctx, log, dep.ID)
	defer stopHeartbeat()

	var lastErr error
	defer func() {
		if lastErr != nil {
			if ctx.Err() != nil {
				// Whatever failed, it failed because the controller is
				// shutting down (see Controller.Run).
				lastErr = errors.New("controller shut down during this deployment; redeploy to retry")
			}
			log.Error("reconcile failed", zap.Error(lastErr))
			// ctx may be cancelled: write the failure on a context of its own.
			failCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), markFailedTimeout)
			defer cancel()
			if err := c.store.MarkFailed(failCtx, dep.ID, lastErr.Error()); err != nil {
				log.Error("failed to mark deployment failed", zap.Error(err))
			}
		}
	}()

	// 1. Fetch app config.
	appCfg, cfgErr := c.store.GetAppConfig(ctx, dep)
	// An invalid security block fails the deployment instead of deploying
	// without the hardening the user asked for.
	var secErr *config.SecurityError
	if errors.As(cfgErr, &secErr) {
		lastErr = fmt.Errorf("invalid canette.yaml: %s", secErr.Msg)
		return
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
		lastErr = fmt.Errorf("get secrets: %w", err)
		return
	}
	secretData := make(map[string][]byte, len(secrets))
	for _, sec := range secrets {
		decrypted, err := crypto.Decrypt(sec.EncryptedValue, c.cryptoKey)
		if err != nil {
			log.Error("failed to decrypt secret", zap.String("key", sec.Key), zap.Error(err))
			lastErr = fmt.Errorf("failed to decrypt app secrets")
			return
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

	// 6. Apply all resources via server-side apply.
	appNS := k8sres.AppNamespace(dep.ProjectID, dep.ProjectSlug)
	c.appendLog(ctx, log, dep.ID, "controller", "Applying Kubernetes resources...")
	applyCtx, warnings := k8sres.WithWarningCollector(ctx)
	if err := k8sres.ApplyAll(applyCtx, c.dynClient, res); err != nil {
		lastErr = fmt.Errorf("apply resources: %w", err)
		return
	}
	c.appendLog(ctx, log, dep.ID, "controller", "Resources applied successfully")
	if psa := warnings.PodSecurityWarnings(); len(psa) > 0 {
		for _, w := range psa {
			c.appendLog(ctx, log, dep.ID, "controller", "Kubernetes warning: "+w)
		}
		if appCfg.Security == nil {
			c.appendLog(ctx, log, dep.ID, "controller",
				"Tip: set security.hardened: true in canette.yaml to meet the stricter Pod Security level, "+
					"see https://canette.dev/docs/security/hardened-mode")
		}
	}

	// 7. Watch rollout — skipped for CronJobs (no Deployment to roll out).
	var livePodName string
	if !isCronJob {
		// Poll every 3s, timeout 12min.
		// K8s progressDeadlineSeconds defaults to 600s (10min); our timeout must exceed that
		// so we see the real ProgressDeadlineExceeded condition rather than timing out first.
		deadline := time.Now().Add(12 * time.Minute)
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				lastErr = ctx.Err()
				return
			default:
			}

			status, err := k8sres.CheckRollout(ctx, c.client, appNS, dep.AppSlug, dep.ID)
			if err != nil {
				log.Warn("check rollout error", zap.Error(err))
			} else {
				c.appendLog(ctx, log, dep.ID, "controller", status.Message)
				if status.Done {
					if status.Succeeded {
						livePodName = status.PodName
						break
					}
					lastErr = fmt.Errorf("rollout failed: %s", status.Message)
					return
				}
			}
			select {
			case <-ctx.Done():
			case <-time.After(3 * time.Second):
			}
		}

		if time.Now().After(deadline) {
			lastErr = fmt.Errorf("rollout timed out after 12 minutes")
			return
		}
	}

	// 8. Mark live and set URL.
	if err := c.store.MarkLive(ctx, dep.ID); err != nil {
		if errors.Is(err, store.ErrNotDeploying) {
			// Already failed (its heartbeat expired) or otherwise moved on: leave
			// its status alone and don't publish a URL for it.
			log.Warn("rollout finished, but the deployment is no longer deploying; not marking it live")
			c.appendLog(ctx, log, dep.ID, "controller",
				"Rollout finished, but this deployment was no longer in progress, so it was not marked live")
			return
		}
		lastErr = fmt.Errorf("mark live: %w", err)
		return
	}
	if c.onDeployLive != nil {
		c.onDeployLive()
	}

	if isCronJob {
		c.appendLog(ctx, log, dep.ID, "controller", fmt.Sprintf("CronJob scheduled with expression: %s", deployCfg.Schedule))
		log.Info("cronjob deployment live", zap.String("schedule", deployCfg.Schedule))
	} else if deployCfg.SkipHTTPRoute {
		if err := c.store.ClearAppLiveURL(ctx, dep.AppID); err != nil {
			log.Warn("failed to clear live url", zap.Error(err))
		}
		clusterDNS := fmt.Sprintf("%s.%s.svc.cluster.local", dep.AppSlug, appNS)
		msg := fmt.Sprintf("Private deployment live. Reachable at %s", clusterDNS)
		if livePodName != "" {
			msg = fmt.Sprintf("%s (pod %s)", msg, livePodName)
		}
		c.appendLog(ctx, log, dep.ID, "controller", msg)
		log.Info("deployment live (private)", zap.String("cluster_dns", clusterDNS), zap.String("pod", livePodName))
	} else {
		liveURL := fmt.Sprintf("https://%s-%s.%s", dep.AppSlug, dep.ProjectSlug, c.cfg.ClusterDomain)
		if err := c.store.SetAppLiveURL(ctx, dep.AppID, liveURL); err != nil {
			log.Warn("failed to set live url", zap.Error(err))
		}
		msg := fmt.Sprintf("Deployment live at %s", liveURL)
		if livePodName != "" {
			msg = fmt.Sprintf("%s (pod %s)", msg, livePodName)
		}
		c.appendLog(ctx, log, dep.ID, "controller", msg)
		log.Info("deployment live", zap.String("url", liveURL), zap.String("pod", livePodName))
	}
	lastErr = nil
}

// heartbeatInterval is how often a running reconcile refreshes its
// deployment's heartbeat. Well within store.DeployingHeartbeatTTL, so a few
// failed writes in a row don't get the deployment failed as abandoned.
const heartbeatInterval = 15 * time.Second

// markFailedTimeout bounds the write of a deployment's failure status.
const markFailedTimeout = 5 * time.Second

// startHeartbeat refreshes the deployment's heartbeat every heartbeatInterval
// until the returned stop function is called. It runs for the whole reconcile,
// not just the rollout poll, so a slow apply is not mistaken for a crash.
func (c *Controller) startHeartbeat(ctx context.Context, log *zap.Logger, deploymentID string) (stop func()) {
	hbCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
				if err := c.store.Heartbeat(hbCtx, deploymentID); err != nil && hbCtx.Err() == nil {
					log.Warn("deployment heartbeat failed", zap.Error(err))
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

func (c *Controller) appendLog(ctx context.Context, log *zap.Logger, deploymentID, stream, line string) {
	if err := c.store.AppendLog(ctx, deploymentID, stream, line); err != nil {
		log.Warn("failed to write controller log", zap.Error(err))
	}
}
