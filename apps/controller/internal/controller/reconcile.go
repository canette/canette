package controller

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"

	"canette.dev/controller/internal/config"
	"canette.dev/controller/internal/crypto"
	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
)

func (c *Controller) reconcile(ctx context.Context, dep store.DeployingDeployment) {
	log := c.log.With(
		zap.String("deployment", dep.ID),
		zap.String("app", dep.AppSlug),
		zap.String("project", dep.ProjectSlug),
	)

	var lastErr error
	defer func() {
		if lastErr != nil {
			log.Error("reconcile failed", zap.Error(lastErr))
			if err := c.store.MarkFailed(ctx, dep.ID, lastErr.Error()); err != nil {
				log.Error("failed to mark deployment failed", zap.Error(err))
			}
		}
	}()

	// 1. Fetch app config.
	appCfg, cfgErr := c.store.GetAppConfig(ctx, dep)
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
	deployCfg := c.buildDeployConfig(appCfg, secretData, imagePullSecretName, imagePullSecretData, skipHTTPRoute)
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
	// Before applying, clear any pods stuck in ImagePullBackOff/ErrImagePull/CrashLoopBackOff
	// so K8s recreates them without exponential backoff on the new spec.
	appNS := k8sres.AppNamespace(dep.ProjectID, dep.ProjectSlug)
	if n, err := k8sres.DeleteStuckPods(ctx, c.client, appNS, dep.AppSlug); err != nil {
		log.Warn("failed to delete stuck pods", zap.Error(err))
	} else if n > 0 {
		msg := fmt.Sprintf("Deleted %d stuck pod(s) before rollout", n)
		log.Info(msg, zap.String("namespace", appNS))
		c.appendLog(ctx, log, dep.ID, "controller", msg)
	}
	c.appendLog(ctx, log, dep.ID, "controller", "Applying Kubernetes resources...")
	if err := k8sres.ApplyAll(ctx, c.dynClient, res); err != nil {
		lastErr = fmt.Errorf("apply resources: %w", err)
		return
	}
	c.appendLog(ctx, log, dep.ID, "controller", "Resources applied successfully")

	// 7. Watch rollout — skipped for CronJobs (no Deployment to roll out).
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

			status, err := k8sres.CheckRollout(ctx, c.client, appNS, dep.AppSlug)
			if err != nil {
				log.Warn("check rollout error", zap.Error(err))
			} else {
				c.appendLog(ctx, log, dep.ID, "controller", status.Message)
				if status.Done {
					if status.Succeeded {
						break
					}
					lastErr = fmt.Errorf("rollout failed: %s", status.Message)
					return
				}
			}
			time.Sleep(3 * time.Second)
		}

		if time.Now().After(deadline) {
			lastErr = fmt.Errorf("rollout timed out after 12 minutes")
			return
		}
	}

	// 8. Mark live and set URL.
	if err := c.store.MarkLive(ctx, dep.ID); err != nil {
		lastErr = fmt.Errorf("mark live: %w", err)
		return
	}

	if isCronJob {
		c.appendLog(ctx, log, dep.ID, "controller", fmt.Sprintf("CronJob scheduled with expression: %s", deployCfg.Schedule))
		log.Info("cronjob deployment live", zap.String("schedule", deployCfg.Schedule))
	} else if deployCfg.SkipHTTPRoute {
		clusterDNS := fmt.Sprintf("%s.%s.svc.cluster.local", dep.AppSlug, appNS)
		c.appendLog(ctx, log, dep.ID, "controller", fmt.Sprintf("Private deployment live. Reachable at %s", clusterDNS))
		log.Info("deployment live (private)", zap.String("cluster_dns", clusterDNS))
	} else {
		liveURL := fmt.Sprintf("https://%s-%s.%s", dep.AppSlug, dep.ProjectSlug, c.cfg.ClusterDomain)
		if err := c.store.SetAppLiveURL(ctx, dep.AppID, liveURL); err != nil {
			log.Warn("failed to set live url", zap.Error(err))
		}
		c.appendLog(ctx, log, dep.ID, "controller", fmt.Sprintf("Deployment live at %s", liveURL))
		log.Info("deployment live", zap.String("url", liveURL))
	}
	lastErr = nil
}

func (c *Controller) appendLog(ctx context.Context, log *zap.Logger, deploymentID, stream, line string) {
	if err := c.store.AppendLog(ctx, deploymentID, stream, line); err != nil {
		log.Warn("failed to write controller log", zap.Error(err))
	}
}
