// Package controller implements the poll loop and per-deployment reconciliation.
package controller

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
)

// Config holds operator-level configuration.
type Config struct {
	PullRepo                string // NodePort-accessible registry for kubelet image pulls, e.g. "registry.192-168-64-2.traefik.me:32500/"
	GatewayName             string
	GatewayNamespace        string
	ClusterDomain           string
	Namespace               string        // canette-build (build job namespace, not app namespace)
	PollInterval            time.Duration
	MaxConcurrent           int
	ImagePullSecretsEnabled bool   // Enable automatic imagePullSecret creation in app namespaces
	RegistryAuthConfigFile  string // Path to mounted .dockerconfigjson file
	RegistryHost            string // Registry host extracted from PullRepo (e.g., "registry.example.com")
}

// Controller polls for deploying deployments and reconciles them.
type Controller struct {
	store      *store.Store
	client     kubernetes.Interface
	dynClient  dynamic.Interface
	cfg        Config
	cryptoKey  []byte
	log        *zap.Logger
	inProgress sync.Map // deploymentID → struct{}{}
}

// New creates a Controller.
func New(
	s *store.Store,
	client kubernetes.Interface,
	dynClient dynamic.Interface,
	cfg Config,
	cryptoKey []byte,
	log *zap.Logger,
) *Controller {
	return &Controller{
		store:     s,
		client:    client,
		dynClient: dynClient,
		cfg:       cfg,
		cryptoKey: cryptoKey,
		log:       log,
	}
}

// Run starts the poll loop; blocks until ctx is cancelled.
func (c *Controller) Run(ctx context.Context) error {
	c.log.Info("controller started",
		zap.Duration("poll_interval", c.cfg.PollInterval),
		zap.Int("max_concurrent", c.cfg.MaxConcurrent),
	)

	ticker := time.NewTicker(c.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.log.Info("controller shutting down")
			return nil
		case <-ticker.C:
			if err := c.processPending(ctx); err != nil {
				c.log.Error("poll cycle error", zap.Error(err))
			}
		}
	}
}

func (c *Controller) processPending(ctx context.Context) error {
	// ClaimDeploying atomically transitions pending_deployment → deploying
	// (UPDATE ... FOR UPDATE SKIP LOCKED), so each row is claimed by exactly
	// one controller instance even when multiple are running.
	deps, err := c.store.ClaimDeploying(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		return err
	}
	for _, dep := range deps {
		go func(d store.DeployingDeployment) {
			c.reconcile(ctx, d)
		}(dep)
	}

	// Tear down stopped deployments.
	stopped, err := c.store.ClaimTeardown(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		c.log.Error("claim teardown error", zap.Error(err))
		// non-fatal: continue with deploy pass
	}
	for _, dep := range stopped {
		key := "teardown:" + dep.ID
		if _, loaded := c.inProgress.LoadOrStore(key, struct{}{}); loaded {
			continue
		}
		go func(d store.StoppedDeployment) {
			defer c.inProgress.Delete("teardown:" + d.ID)
			c.runTeardown(ctx, d)
		}(dep)
	}

	// Delete orphaned namespaces from project renames.
	nsDels, err := c.store.ClaimNamespaceDeletions(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		c.log.Error("claim namespace deletions error", zap.Error(err))
	} else {
		for _, nd := range nsDels {
			go func(d store.PendingNamespaceDeletion) {
				if err := k8sres.DeleteNamespace(ctx, c.dynClient, d.Namespace); err != nil {
					c.log.Warn("namespace deletion error",
						zap.String("namespace", d.Namespace),
						zap.Error(err))
					return // will retry next poll
				}
				if err := c.store.MarkNamespaceDeleted(ctx, d.ID); err != nil {
					c.log.Warn("mark namespace deleted error", zap.Error(err))
				}
				c.log.Info("namespace deleted", zap.String("namespace", d.Namespace))
			}(nd)
		}
	}

	return nil
}

// buildDeployConfig translates store+config into k8s.DeployConfig.
func (c *Controller) buildDeployConfig(cfg *store.AppConfig, secretData map[string][]byte, imagePullSecretName string, imagePullSecretData []byte) k8sres.DeployConfig {
	var imageRef string
	if cfg.SourceType == "image" {
		// image_digest holds the full external image reference (e.g. "nginx:latest")
		imageRef = cfg.ImageDigest
	} else {
		imageRef = c.cfg.PullRepo + cfg.ProjectSlug + "/" + cfg.AppSlug + "@" + cfg.ImageDigest
	}

	envMap := cfg.Env
	if envMap == nil {
		envMap = make(map[string]string)
	}

	return k8sres.DeployConfig{
		ProjectID:           cfg.ProjectID,
		ProjectSlug:         cfg.ProjectSlug,
		ProjectOwner:        cfg.ProjectOwner,
		AppSlug:             cfg.AppSlug,
		ImageRef:            imageRef,
		Port:                cfg.Port,
		Replicas:            cfg.Replicas,
		Resources: k8sres.Resources{
			CPURequest:    cfg.Resources.CPURequest,
			MemoryRequest: cfg.Resources.MemoryRequest,
			CPULimit:      cfg.Resources.CPULimit,
			MemoryLimit:   cfg.Resources.MemoryLimit,
		},
		EnvVars:             envMap,
		SecretData:          secretData,
		GatewayName:         c.cfg.GatewayName,
		GatewayNamespace:    c.cfg.GatewayNamespace,
		ClusterDomain:       c.cfg.ClusterDomain,
		ImagePullSecretName: imagePullSecretName,
		ImagePullSecretData: imagePullSecretData,
	}
}
