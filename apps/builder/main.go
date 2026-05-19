package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
	"go.uber.org/zap"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"canette.dev/builder/internal/builder"
	k8sjobs "canette.dev/builder/internal/k8s"
	"canette.dev/builder/internal/scanner"
	"canette.dev/builder/internal/store"
	"canette.dev/lib/crypto"
	"canette.dev/lib/env"
	"canette.dev/lib/health"
)

func main() {
	logLevel := os.Getenv("LOG_LEVEL") // "debug", "info" (default), "warn", "error"
	zapCfg := zap.NewProductionConfig()
	if err := zapCfg.Level.UnmarshalText([]byte(logLevel)); err != nil {
		zapCfg.Level.SetLevel(zap.InfoLevel)
	}
	log, _ := zapCfg.Build()
	defer func() { _ = log.Sync() }()

	if err := run(log); err != nil {
		log.Fatal("fatal error", zap.Error(err))
	}
}

func run(log *zap.Logger) error {
	// ── .env file (local dev only) ─────────────────────────────────────────────
	if _, err := os.Stat(".env"); err == nil {
		_ = godotenv.Load()
	}

	// ── Encryption key ─────────────────────────────────────────────────────────
	encKey, err := env.RequireEnv("ENCRYPTION_KEY")
	if err != nil {
		return err
	}
	cryptoKey, err := crypto.NewKey(encKey)
	if err != nil {
		return fmt.Errorf("ENCRYPTION_KEY: %w", err)
	}

	// ── Database ───────────────────────────────────────────────────────────────
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

	// ── Kubernetes client ──────────────────────────────────────────────────────
	k8sClient, err := buildK8sClient()
	if err != nil {
		return fmt.Errorf("build k8s client: %w", err)
	}

	// ── Build config ───────────────────────────────────────────────────────────
	imageRepo, err := env.RequireEnv("IMAGE_REPO")
	if err != nil {
		return err
	}
	imageRepo = strings.TrimSuffix(imageRepo, "/") + "/"

	builderImage, err := env.RequireEnv("BUILDER_IMAGE")
	if err != nil {
		return err
	}
	gitInitImage, err := env.RequireEnv("GIT_INIT_IMAGE")
	if err != nil {
		return err
	}

	cfg := k8sjobs.BuildConfig{
		Namespace:          env.EnvOr("BUILDER_NAMESPACE", "canette-build"),
		ImageRepo:          imageRepo,
		BuildkitdAddr:      env.EnvOr("BUILDKITD_ADDR", "tcp://buildkitd.canette-build.svc.cluster.local:1234"),
		BuilderImage:       builderImage,
		GitInitImage:       gitInitImage,
		RegistryAuthSecret: env.EnvOr("REGISTRY_AUTH_SECRET", ""),
		RegistryAuthType:   env.EnvOr("REGISTRY_AUTH_TYPE", ""),
	}

	s := store.New(db, log)

	scanCfg := scanner.Config{
		Provider:      env.EnvOr("SCAN_PROVIDER", "auto"),
		EnabledStr:    os.Getenv("SCAN_ENABLED"), // "" = provider-aware default
		Mandatory:     os.Getenv("SCAN_MANDATORY") == "true",
		FailSeverity:  env.EnvOr("SCAN_FAIL_SEVERITY", "HIGH"),
		TrivyImage:    env.EnvOr("TRIVY_IMAGE", "aquasec/trivy:0.70.0"),
		SBOMEnabled:   os.Getenv("SCAN_SBOM_ENABLED") == "true",
		K8sClient:     k8sClient,
		Namespace:     cfg.Namespace,
		RegAuthSecret: cfg.RegistryAuthSecret,
		LogAppender:   s,
		ImageRepo:     imageRepo,
		Log:           log,
	}

	pollInterval, err := time.ParseDuration(env.EnvOr("POLL_INTERVAL", "5s"))
	if err != nil {
		return fmt.Errorf("POLL_INTERVAL: %w", err)
	}
	maxConcurrent, err := strconv.Atoi(env.EnvOr("MAX_CONCURRENT", "3"))
	if err != nil {
		return fmt.Errorf("MAX_CONCURRENT: %w", err)
	}

	log.Info("canette builder starting",
		zap.String("namespace", cfg.Namespace),
		zap.String("image_repo", cfg.ImageRepo),
		zap.String("buildkitd", cfg.BuildkitdAddr),
		zap.String("builder_image", cfg.BuilderImage),
		zap.Duration("poll_interval", pollInterval),
	)

	// ── Run ────────────────────────────────────────────────────────────────────
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	health.StartServer(ctx, log, env.EnvOr("HEALTH_ADDR", ":8081"))

	b := builder.New(
		s,
		k8sClient,
		cfg,
		cryptoKey,
		log,
		pollInterval,
		maxConcurrent,
		scanCfg,
	)
	return b.Run(ctx)
}

func buildK8sClient() (kubernetes.Interface, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		kubeconfig := env.EnvOr("KUBECONFIG", "")
		if kubeconfig == "" {
			home, _ := os.UserHomeDir()
			kubeconfig = filepath.Join(home, ".kube", "config")
		}
		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig from %s: %w", kubeconfig, err)
		}
	}
	return kubernetes.NewForConfig(config)
}
