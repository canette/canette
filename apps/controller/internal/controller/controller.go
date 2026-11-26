// Package controller implements the poll loop and per-deployment reconciliation.
package controller

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"canette.dev/controller/internal/config"
	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
	"canette.dev/lib/failpoint"
	libk8s "canette.dev/lib/k8s"
)

// Config holds operator-level configuration.
type Config struct {
	PullRepo                string // NodePort-accessible registry for kubelet image pulls, e.g. "registry.192-168-64-2.traefik.me:32500/"
	GatewayName             string
	GatewayNamespace        string
	ClusterDomain           string
	Namespace               string // canette-build (build job namespace, not app namespace)
	PollInterval            time.Duration
	MaxConcurrent           int
	ImagePullSecretsEnabled bool   // Enable automatic imagePullSecret creation in app namespaces
	NetworkPolicyEnabled    bool   // Enable the default per-app NetworkPolicy (ingress from Gateway ns, egress DNS + non-private internet)
	RegistryAuthConfigFile  string // Path to mounted .dockerconfigjson file
	RegistryHost            string // Registry host extracted from PullRepo (e.g., "registry.example.com")
	AuthgateImage           string // canette-authgate sidecar image ref, only used when an app's password gate is enabled
	AuthgateImagePullPolicy string // imagePullPolicy for the authgate sidecar; empty leaves the Kubernetes default
	Workload                k8sres.WorkloadDefaults
	NamespacePolicy         k8sres.NamespacePolicy
	StorageClassName        string // PVC storage class for new volumes; empty uses the cluster default
}

// Controller polls for apps whose intent needs work and reconciles them.
type Controller struct {
	store     *store.Store
	client    kubernetes.Interface
	dynClient dynamic.Interface
	cfg       Config
	cryptoKey []byte
	log       *zap.Logger

	// appSlots bounds the app workers running at once to MaxConcurrent,
	// across poll cycles. Only processPending acquires a slot, so the number
	// of free slots it sees can only grow before it claims.
	appSlots chan struct{}
	working  sync.Map // appID → struct{}{}, app workers running in this process
	workers  sync.WaitGroup

	// applyAll and checkRollout are k8sres.ApplyAll and k8sres.CheckRollout.
	// Tests replace them, because the fake dynamic client can't server-side
	// apply and the fake clientset has no rollout controller.
	applyAll     func(context.Context, dynamic.Interface, k8sres.AppResources) error
	checkRollout func(ctx context.Context, client kubernetes.Interface, namespace, name, deploymentID string) (k8sres.RolloutStatus, error)

	// rolloutPollInterval is how often a worker checks a rollout (and the
	// app's intent) while it waits.
	rolloutPollInterval time.Duration

	// onDeployLive, if set, is called right after a deployment is marked
	// live — lets the health watcher learn about it immediately instead of
	// waiting for its own poll ticker. Nil-safe: never called if unset.
	onDeployLive func()
}

// New creates a Controller. onDeployLive is called right after a deployment
// is marked live (e.g. to nudge the health watcher's current-deployment
// refresh); pass nil if nothing needs to observe that.
func New(
	s *store.Store,
	client kubernetes.Interface,
	dynClient dynamic.Interface,
	cfg Config,
	cryptoKey []byte,
	log *zap.Logger,
	onDeployLive func(),
) *Controller {
	return &Controller{
		appSlots:            make(chan struct{}, max(cfg.MaxConcurrent, 1)),
		store:               s,
		client:              client,
		dynClient:           dynClient,
		cfg:                 cfg,
		cryptoKey:           cryptoKey,
		log:                 log,
		applyAll:            k8sres.ApplyAll,
		checkRollout:        k8sres.CheckRollout,
		rolloutPollInterval: 3 * time.Second,
		onDeployLive:        onDeployLive,
	}
}

// shutdownDrainTimeout is how long Run lets running workers finish after ctx
// is cancelled, before cancelling them. shutdownFailTimeout is how long it then
// waits for them to record the failure. The chart's
// terminationGracePeriodSeconds (charts/canette/templates/controller/deployment.yaml)
// must be longer than both together.
const (
	shutdownDrainTimeout = 20 * time.Second
	shutdownFailTimeout  = 5 * time.Second
)

// Run starts the poll loop; blocks until ctx is cancelled and the workers it
// started have stopped (bounded by shutdownDrainTimeout + shutdownFailTimeout).
func (c *Controller) Run(ctx context.Context) error {
	c.log.Info("controller started",
		zap.Duration("poll_interval", c.cfg.PollInterval),
		zap.Int("max_concurrent", c.cfg.MaxConcurrent),
	)

	// Leases left by the previous controller process are dead: resume their
	// apps now rather than when the leases expire.
	if n, err := c.store.ReleaseAllLeases(ctx); err != nil {
		c.log.Warn("release leases of the previous controller failed; they expire on their own", zap.Error(err))
	} else if n > 0 {
		c.log.Info("resuming apps the previous controller was working on", zap.Int64("apps", n))
	}

	// Workers run on their own context, so a shutdown gives a rollout that is
	// nearly done the chance to finish instead of failing it straight away.
	workCtx, cancelWork := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelWork()

	ticker := time.NewTicker(c.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.log.Info("controller shutting down, waiting for running workers",
				zap.Duration("timeout", shutdownDrainTimeout))
			if !c.waitWorkers(shutdownDrainTimeout) {
				c.log.Warn("workers still running, cancelling them")
				cancelWork()
				if !c.waitWorkers(shutdownFailTimeout) {
					c.log.Warn("workers did not stop in time; the next controller resumes their apps once their leases expire")
				}
			}
			return nil
		case <-ticker.C:
			if err := c.processPending(ctx, workCtx); err != nil {
				c.log.Error("poll cycle error", zap.Error(err))
			}
		}
	}
}

// waitWorkers waits up to timeout for every worker to return, and reports
// whether they all did.
func (c *Controller) waitWorkers(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		c.workers.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// goWorker runs fn in a goroutine that Run waits for on shutdown.
func (c *Controller) goWorker(fn func()) {
	c.workers.Add(1)
	go func() {
		defer c.workers.Done()
		fn()
	}()
}

// runningApps returns the IDs of the apps this process has workers for.
func (c *Controller) runningApps() []string {
	var ids []string
	c.working.Range(func(k, _ any) bool {
		ids = append(ids, k.(string))
		return true
	})
	return ids
}

// processPending claims queued work and starts a worker for each item. Claims
// run on ctx, which stops on shutdown; workers run on workCtx (see Run).
func (c *Controller) processPending(ctx, workCtx context.Context) error {
	// Lifecycle actions of an API pod that predates intents, during an
	// upgrade, become intent (until part 3 of #354).
	adopted, err := c.store.AdoptLegacyWrites(ctx)
	if err != nil {
		c.log.Error("adopt legacy lifecycle writes error", zap.Error(err))
	}
	for _, id := range adopted {
		c.log.Info("recorded a deploy or stop from an older API in the app's intent", zap.String("app_id", id))
	}

	// Attempts that finished building after a newer deploy or a Stop never
	// roll out.
	superseded, err := c.store.SweepSuperseded(ctx)
	if err != nil {
		c.log.Error("sweep superseded deployments error", zap.Error(err))
	}
	for _, id := range superseded {
		c.log.Info("deployment superseded before it was rolled out", zap.String("deployment", id))
	}

	// ClaimApps leases apps whose intent needs work (UPDATE ... FOR UPDATE
	// SKIP LOCKED), so each app has one worker even with several controllers,
	// and a crashed controller's apps are claimed again once their leases
	// expire. Only as many apps are claimed as there are free slots, so a
	// claimed app never waits.
	free := cap(c.appSlots) - len(c.appSlots)
	leases, err := c.store.ClaimApps(ctx, free, c.runningApps())
	if err != nil {
		return err
	}
	if len(leases) > 0 {
		failpoint.Hit("after-claim")
	}
	for _, lease := range leases {
		c.appSlots <- struct{}{}
		c.working.Store(lease.AppID, struct{}{})
		c.goWorker(func() {
			defer func() {
				c.working.Delete(lease.AppID)
				<-c.appSlots
			}()
			c.runApp(workCtx, lease)
		})
	}

	// Delete namespaces left behind by project renames and deletes.
	nsDels, err := c.store.ClaimNamespaceDeletions(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		c.log.Error("claim namespace deletions error", zap.Error(err))
	} else {
		for _, d := range nsDels {
			c.goWorker(func() {
				ns := k8sres.AppNamespace(d.ProjectID, d.ProjectSlug)
				pvcs, err := cleanupQueuedNamespace(workCtx, c.dynClient, d)
				if err != nil {
					c.log.Warn("namespace deletion error",
						zap.String("namespace", ns),
						zap.Error(err))
					return // will retry next poll
				}
				if len(pvcs) > 0 {
					reason := namespaceBlockedReason(pvcs)
					log := c.log.Debug
					if reason != d.BlockedReason {
						log = c.log.Warn // first block, or the PVCs changed
					}
					log("not deleting renamed project's old namespace: it still holds PVCs; move or delete them by hand",
						zap.String("namespace", ns),
						zap.Strings("pvcs", pvcs),
						zap.Duration("retry_in", namespaceBlockedRetry))
					if err := c.store.MarkNamespaceBlocked(workCtx, d.ID, reason, time.Now().Add(namespaceBlockedRetry)); err != nil {
						c.log.Warn("mark namespace blocked error", zap.Error(err))
					}
					return // row stays queued
				}
				if err := c.store.MarkNamespaceDeleted(workCtx, d.ID); err != nil {
					c.log.Warn("mark namespace deleted error", zap.Error(err))
				}
				c.log.Info("namespace deleted", zap.String("namespace", ns))
			})
		}
	}

	// Delete every K8s resource of apps deleted from canette.
	appCleanups, err := c.store.ClaimAppCleanups(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		c.log.Error("claim app cleanups error", zap.Error(err))
	} else {
		for _, d := range appCleanups {
			c.goWorker(func() {
				ns := k8sres.AppNamespace(d.ProjectID, d.ProjectSlug)
				log := c.log.With(zap.String("namespace", ns), zap.String("app", d.AppSlug))
				if err := k8sres.DeleteApp(workCtx, c.dynClient, ns, d.AppSlug); err != nil {
					log.Warn("app cleanup error", zap.Error(err))
					return // claim expires, retried on a later poll
				}
				failpoint.Hit("after-app-delete")
				if err := c.store.MarkAppCleanedUp(workCtx, d.ID); err != nil {
					log.Warn("mark app cleaned up error", zap.Error(err))
				}
				log.Info("deleted app resources")
			})
		}
	}

	// Delete K8s resources for volumes removed from canette.
	volDels, err := c.store.ClaimVolumeDeletions(ctx, c.cfg.MaxConcurrent)
	if err != nil {
		c.log.Error("claim volume deletions error", zap.Error(err))
	} else {
		for _, d := range volDels {
			c.goWorker(func() {
				ns, kind, name, err := resolveVolumeDeletion(d)
				if err != nil {
					// Can't happen with the table's CHECK constraints; the claim
					// expires and the row is retried (and logged) again later.
					c.log.Error("invalid volume deletion row", zap.String("id", d.ID), zap.Error(err))
					return
				}
				if err := k8sres.DeleteVolumeResource(workCtx, c.dynClient, kind, ns, name); err != nil {
					c.log.Warn("volume deletion error",
						zap.String("resource_type", kind),
						zap.String("namespace", ns),
						zap.String("name", name),
						zap.Error(err))
					return // will retry next poll
				}
				if err := c.store.MarkVolumeDeleted(workCtx, d.ID); err != nil {
					c.log.Warn("mark volume deleted error", zap.Error(err))
				}
				c.log.Info("volume resource deleted",
					zap.String("resource_type", kind),
					zap.String("namespace", ns),
					zap.String("name", name))
			})
		}
	}

	return nil
}

// resolveVolumeDeletion maps a queued volume deletion to the namespace, kind
// and name of the K8s resource to delete, using the same naming helpers that
// created it. Legacy rows (queued before migration 000018) are already resolved.
func resolveVolumeDeletion(d store.PendingVolumeDeletion) (namespace, kind, name string, err error) {
	if d.LegacyNamespace != "" {
		return d.LegacyNamespace, d.LegacyResourceType, d.LegacyResourceName, nil
	}
	kind, name, ok := libk8s.VolumeResource(d.AppSlug, d.VolumeName, d.VolumeType)
	if !ok {
		return "", "", "", fmt.Errorf("volume type %q has no K8s resource to delete", d.VolumeType)
	}
	return libk8s.AppNamespace(d.ProjectID, d.ProjectSlug), kind, name, nil
}

// buildDeployConfig translates store+config into k8s.DeployConfig.
func (c *Controller) buildDeployConfig(cfg *store.AppConfig, secretData map[string][]byte, imagePullSecretName string, imagePullSecretData []byte, skipHTTPRoute bool, deploymentID string) k8sres.DeployConfig {
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

	volumes := make([]k8sres.VolumeSpec, 0, len(cfg.Volumes))
	for _, v := range cfg.Volumes {
		volumes = append(volumes, k8sres.VolumeSpec{
			Name:      v.Name,
			Type:      v.Type,
			MountPath: v.MountPath,
			Size:      v.Config.Size,
			Content:   v.Config.Content,
		})
	}

	return k8sres.DeployConfig{
		ProjectID:    cfg.ProjectID,
		ProjectSlug:  cfg.ProjectSlug,
		ProjectOwner: cfg.ProjectOwner,
		AppSlug:      cfg.AppSlug,
		ImageRef:     imageRef,
		Command:      cfg.Command,
		Port:         cfg.Port,
		Replicas:     cfg.Replicas,
		Resources: k8sres.Resources{
			CPURequest:    cfg.Resources.CPURequest,
			MemoryRequest: cfg.Resources.MemoryRequest,
			CPULimit:      cfg.Resources.CPULimit,
			MemoryLimit:   cfg.Resources.MemoryLimit,
		},
		EnvVars:              envMap,
		SecretData:           secretData,
		GatewayName:          c.cfg.GatewayName,
		GatewayNamespace:     c.cfg.GatewayNamespace,
		NetworkPolicyEnabled: c.cfg.NetworkPolicyEnabled,
		ClusterDomain:        c.cfg.ClusterDomain,
		SkipHTTPRoute:        skipHTTPRoute,
		IsCronJob:            cfg.DeploymentType == "cronjob",
		Schedule:             cfg.Schedule,
		ImagePullSecretName:  imagePullSecretName,
		ImagePullSecretData:  imagePullSecretData,
		Volumes:              volumes,
		ExtraHostnames:       cfg.ExtraHostnames,
		CommitSha:            cfg.CommitSha,
		DeploymentID:         deploymentID,
		PasswordGate: k8sres.PasswordGateConfig{
			Enabled:      cfg.PasswordGate.Enabled,
			PasswordHash: cfg.PasswordGate.PasswordHash,
		},
		AuthgateImage:           c.cfg.AuthgateImage,
		AuthgateImagePullPolicy: c.cfg.AuthgateImagePullPolicy,
		Healthcheck:             healthcheckSpec(cfg.Healthcheck),
		Security:                securitySpec(cfg.Security),
		Workload:                c.cfg.Workload,
		NamespacePolicy:         c.cfg.NamespacePolicy,
		StorageClassName:        c.cfg.StorageClassName,
	}
}

// securitySpec converts the resolved canette.yaml hardened mode (see
// config.ResolveSecurity) into the k8s package's own spec type.
func securitySpec(h *config.Hardening) *k8sres.SecuritySpec {
	if h == nil {
		return nil
	}
	return &k8sres.SecuritySpec{
		User:           h.User,
		ReadOnlyRootFS: h.ReadOnlyRootFS,
		WritablePaths:  h.WritablePaths,
	}
}

// healthcheckSpec converts the store's resolved healthcheck (built from
// canette.yaml, see store.GetAppConfig) into the k8s package's own spec type.
func healthcheckSpec(hc *store.Healthcheck) *k8sres.HealthcheckSpec {
	if hc == nil {
		return nil
	}
	return &k8sres.HealthcheckSpec{
		Path:                hc.Path,
		Port:                hc.Port,
		InitialDelaySeconds: hc.InitialDelaySeconds,
		PeriodSeconds:       hc.PeriodSeconds,
	}
}

// namespaceBlockedRetry is how long a namespace kept for its PVCs waits before
// it is checked again. Long enough not to flood the logs or the K8s API,
// short enough that the cleanup finishes soon after the PVCs are removed.
const namespaceBlockedRetry = 10 * time.Minute

// namespaceBlockedReason is stored on a blocked queue row, so the controller
// can tell a repeat check from a new block.
func namespaceBlockedReason(pvcs []string) string {
	sorted := slices.Sorted(slices.Values(pvcs))
	return "holds PVCs: " + strings.Join(sorted, ", ")
}

// cleanupQueuedNamespace deletes a namespace from queued_namespace_cleanups.
// A namespace queued by a slug rename (the project still exists) is kept while
// it holds any PVC, since deleting it would take the volume data with it; the
// PVC names are returned and the row must stay queued. A deleted project's
// namespace is always deleted.
func cleanupQueuedNamespace(ctx context.Context, dyn dynamic.Interface, d store.PendingNamespaceDeletion) ([]string, error) {
	ns := k8sres.AppNamespace(d.ProjectID, d.ProjectSlug)
	if d.ProjectExists {
		pvcs, err := k8sres.ListPVCNames(ctx, dyn, ns)
		if err != nil {
			return nil, err
		}
		if len(pvcs) > 0 {
			return pvcs, nil
		}
	}
	return nil, k8sres.DeleteNamespace(ctx, dyn, ns)
}
