package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"strings"
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
	"canette.dev/controller/internal/crypto"
	"canette.dev/controller/internal/store"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

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
	encKeyHex, err := requireEnv("ENCRYPTION_KEY")
	if err != nil {
		return err
	}
	cryptoKey, err := crypto.NewKey(encKeyHex)
	if err != nil {
		return fmt.Errorf("invalid ENCRYPTION_KEY: %w", err)
	}

	// ── Database ──────────────────────────────────────────────────────────────
	dbURL := envOr("DATABASE_URL", "postgresql://canette:canette@localhost:5432/canette")
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

	k8sClient, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("create dynamic client: %w", err)
	}

	// ── Controller config ─────────────────────────────────────────────────────
	pollInterval, err := time.ParseDuration(envOr("POLL_INTERVAL", "5s"))
	if err != nil {
		return fmt.Errorf("invalid POLL_INTERVAL: %w", err)
	}
	maxConcurrent := 3
	if v := os.Getenv("MAX_CONCURRENT"); v != "" {
		if _, err := fmt.Sscan(v, &maxConcurrent); err != nil {
			return fmt.Errorf("invalid MAX_CONCURRENT: %w", err)
		}
	}

	pullRepo, err := requireEnv("PULL_REPO")
	if err != nil {
		return err
	}
	pullRepo = strings.TrimSuffix(pullRepo, "/") + "/"

	clusterDomain, err := requireEnv("CLUSTER_DOMAIN")
	if err != nil {
		return err
	}

	cfg := controller.Config{
		PullRepo:         pullRepo,
		GatewayName:      envOr("GATEWAY_NAME", "can-gateway"),
		GatewayNamespace: envOr("GATEWAY_NAMESPACE", "kube-system"),
		ClusterDomain:    clusterDomain,
		Namespace:        envOr("BUILDER_NAMESPACE", "canette-build"),
		PollInterval:     pollInterval,
		MaxConcurrent:    maxConcurrent,
	}

	// ── Run ───────────────────────────────────────────────────────────────────
	ctrl := controller.New(s, k8sClient, dynClient, cfg, cryptoKey, log)
	return ctrl.Run(ctx)
}

func loadKubeConfig() (*rest.Config, error) {
	// In-cluster config takes precedence.
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	kubeconfig := envOr("KUBECONFIG", clientcmd.RecommendedHomeFile)
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}

func requireEnv(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("%s environment variable is required", key)
	}
	return v, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
