package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
	"go.uber.org/zap"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"canette.dev/controller/internal/controller"
	controllerhealth "canette.dev/controller/internal/health"
	k8sres "canette.dev/controller/internal/k8s"
	"canette.dev/controller/internal/store"
	"canette.dev/lib/crypto"
	"canette.dev/lib/env"
	"canette.dev/lib/health"
)

func main() {
	log, _ := zap.NewProduction()
	defer func() { _ = log.Sync() }()

	log.Info("canette controller starting")

	if err := run(log); err != nil {
		log.Fatal("controller error", zap.Error(err))
	}
}

func run(log *zap.Logger) error {
	// ── .env file (local dev only) ────────────────────────────────────────────
	if _, err := os.Stat(".env"); err == nil {
		_ = godotenv.Load()
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// ── Encryption key ────────────────────────────────────────────────────────
	encKeyHex, err := env.RequireEnv("ENCRYPTION_KEY")
	if err != nil {
		return err
	}
	cryptoKey, err := crypto.NewKey(encKeyHex)
	if err != nil {
		return fmt.Errorf("invalid ENCRYPTION_KEY: %w", err)
	}

	// ── Database ──────────────────────────────────────────────────────────────
	dbURL := env.EnvOr("DATABASE_URL", "postgresql://canette:canette@localhost:5432/canette")
	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}

	s := store.New(db, log)

	// ── Kubernetes clients ────────────────────────────────────────────────────
	restCfg, err := loadKubeConfig()
	if err != nil {
		return fmt.Errorf("load kubeconfig: %w", err)
	}
	// Route API server warnings (e.g. Pod Security "would violate restricted"
	// on every app apply) to the structured log instead of stderr.
	restCfg.WarningHandler = newWarningLogger(log)

	k8sClient, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("create dynamic client: %w", err)
	}

	// ── Controller config ─────────────────────────────────────────────────────
	pollInterval, err := time.ParseDuration(env.EnvOr("POLL_INTERVAL", "5s"))
	if err != nil {
		return fmt.Errorf("invalid POLL_INTERVAL: %w", err)
	}
	maxConcurrent := 3
	if v := os.Getenv("MAX_CONCURRENT"); v != "" {
		if _, err := fmt.Sscan(v, &maxConcurrent); err != nil {
			return fmt.Errorf("invalid MAX_CONCURRENT: %w", err)
		}
	}

	pullRepo, err := env.RequireEnv("PULL_REPO")
	if err != nil {
		return err
	}
	pullRepo = strings.TrimSuffix(pullRepo, "/") + "/"

	clusterDomain, err := env.RequireEnv("CLUSTER_DOMAIN")
	if err != nil {
		return err
	}

	authgateImage, err := env.RequireEnv("AUTHGATE_IMAGE")
	if err != nil {
		return err
	}

	// Extract registry host from pullRepo for imagePullSecret matching
	// e.g., "registry.example.com/" → "registry.example.com"
	registryHost := strings.TrimSuffix(pullRepo, "/")
	if idx := strings.Index(registryHost, "/"); idx != -1 {
		registryHost = registryHost[:idx]
	}

	workload, err := loadWorkloadDefaults()
	if err != nil {
		return err
	}
	nsPolicy, err := loadNamespacePolicy()
	if err != nil {
		return err
	}

	imagePullSecretsEnabled := env.EnvOr("IMAGE_PULL_SECRETS_ENABLED", "true") == "true"
	networkPolicyEnabled := env.EnvOr("NETWORK_POLICY_ENABLED", "true") == "true"
	registryAuthConfigFile := env.EnvOr("REGISTRY_AUTH_CONFIG_FILE", "")

	cfg := controller.Config{
		PullRepo:                pullRepo,
		GatewayName:             env.EnvOr("GATEWAY_NAME", "can-gateway"),
		GatewayNamespace:        env.EnvOr("GATEWAY_NAMESPACE", "kube-system"),
		NetworkPolicyEnabled:    networkPolicyEnabled,
		ClusterDomain:           clusterDomain,
		Namespace:               env.EnvOr("BUILDER_NAMESPACE", "canette-build"),
		PollInterval:            pollInterval,
		MaxConcurrent:           maxConcurrent,
		ImagePullSecretsEnabled: imagePullSecretsEnabled,
		RegistryAuthConfigFile:  registryAuthConfigFile,
		RegistryHost:            registryHost,
		AuthgateImage:           authgateImage,
		Workload:                workload,
		NamespacePolicy:         nsPolicy,
		StorageClassName:        os.Getenv("STORAGE_CLASS_NAME"),
	}

	// ── Run ───────────────────────────────────────────────────────────────────
	health.StartServer(ctx, log, env.EnvOr("HEALTH_ADDR", ":8082"))

	// Background runtime-health watcher: reacts to pod state changes
	// cluster-wide so an already-`live` app that later crashes is detected
	// without waiting for the next deploy. Runs alongside the deploy
	// reconciler, sharing the same ctx so both stop together on shutdown.
	// Safe to run unguarded by leader election: the controller Deployment is
	// hardcoded to replicas:1 (charts/canette/templates/controller/deployment.yaml).
	watcher := controllerhealth.New(k8sClient, s, log)
	go func() {
		if err := watcher.Run(ctx); err != nil {
			log.Error("health watcher error", zap.Error(err))
		}
	}()

	// Passing watcher.TriggerRefresh lets the reconciler nudge the health
	// watcher the instant a deployment goes live, instead of it learning
	// that up to currentDeploymentRefresh later — closing a window where
	// the watcher can misread an already-healthy new pod as "no pods" for
	// a still-current-in-its-view superseded deployment.
	ctrl := controller.New(s, k8sClient, dynClient, cfg, cryptoKey, log, watcher.TriggerRefresh)
	return ctrl.Run(ctx)
}

// loadWorkloadDefaults reads the platform-wide workload settings set from
// Helm values (controller.workloads). The fallbacks match the chart defaults;
// -1 leaves a field to the Kubernetes default, 0 is passed through as is.
func loadWorkloadDefaults() (k8sres.WorkloadDefaults, error) {
	var w k8sres.WorkloadDefaults
	fields := []struct {
		key string
		def int
		dst **int
	}{
		{"TERMINATION_GRACE_PERIOD_SECONDS", 30, &w.TerminationGracePeriodSeconds},
		{"REVISION_HISTORY_LIMIT", 3, &w.RevisionHistoryLimit},
		{"CRONJOB_STARTING_DEADLINE_SECONDS", 300, &w.CronJobStartingDeadlineSeconds},
		{"CRONJOB_BACKOFF_LIMIT", 2, &w.CronJobBackoffLimit},
		{"CRONJOB_ACTIVE_DEADLINE_SECONDS", 21600, &w.CronJobActiveDeadlineSeconds},
		{"CRONJOB_TTL_SECONDS_AFTER_FINISHED", 86400, &w.CronJobTTLSecondsAfterFinished},
	}
	for _, f := range fields {
		n := f.def
		if v := os.Getenv(f.key); v != "" {
			parsed, err := strconv.Atoi(v)
			if err != nil || parsed < -1 {
				return w, fmt.Errorf("invalid %s %q: must be an integer >= 0, or -1 to leave it unset", f.key, v)
			}
			n = parsed
		}
		if n >= 0 {
			*f.dst = &n
		}
	}
	return w, nil
}

// loadNamespacePolicy reads the per-namespace settings set from Helm values
// (controller.podSecurity, controller.namespaceQuota, controller.namespaceLimitRange).
func loadNamespacePolicy() (k8sres.NamespacePolicy, error) {
	var p k8sres.NamespacePolicy
	levels := []struct {
		key string
		def string
		dst *string
	}{
		{"POD_SECURITY_ENFORCE", "baseline", &p.PodSecurity.Enforce},
		{"POD_SECURITY_WARN", "restricted", &p.PodSecurity.Warn},
		{"POD_SECURITY_AUDIT", "restricted", &p.PodSecurity.Audit},
	}
	for _, l := range levels {
		v, set := os.LookupEnv(l.key)
		if !set {
			v = l.def
		}
		switch v {
		case "", "privileged", "baseline", "restricted":
			*l.dst = v
		default:
			return p, fmt.Errorf("invalid %s %q: must be privileged, baseline, restricted or empty", l.key, v)
		}
	}

	if v := os.Getenv("NAMESPACE_QUOTA_HARD"); v != "" {
		if err := json.Unmarshal([]byte(v), &p.QuotaHard); err != nil {
			return p, fmt.Errorf("invalid NAMESPACE_QUOTA_HARD: must be a JSON object: %w", err)
		}
	}
	if v := os.Getenv("NAMESPACE_LIMIT_RANGE_LIMITS"); v != "" {
		if err := json.Unmarshal([]byte(v), &p.LimitRangeLimits); err != nil {
			return p, fmt.Errorf("invalid NAMESPACE_LIMIT_RANGE_LIMITS: must be a JSON list: %w", err)
		}
	}
	return p, nil
}

// warningLogger logs API server warnings once each. Pod Security warnings
// repeat on every apply of the same app, so repeats are dropped.
type warningLogger struct {
	log  *zap.Logger
	mu   sync.Mutex
	seen map[string]struct{}
}

func newWarningLogger(log *zap.Logger) *warningLogger {
	return &warningLogger{log: log, seen: map[string]struct{}{}}
}

func (w *warningLogger) HandleWarningHeader(_ int, _ string, text string) {
	if text == "" {
		return
	}
	w.mu.Lock()
	_, dup := w.seen[text]
	if !dup {
		// Bound memory: start over rather than grow without limit.
		if len(w.seen) >= 1000 {
			w.seen = map[string]struct{}{}
		}
		w.seen[text] = struct{}{}
	}
	w.mu.Unlock()
	if !dup {
		w.log.Info("kubernetes api warning", zap.String("warning", text))
	}
}

func loadKubeConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	kubeconfig := env.EnvOr("KUBECONFIG", clientcmd.RecommendedHomeFile)
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}
