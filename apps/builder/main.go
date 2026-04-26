package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
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
	"canette.dev/builder/internal/crypto"
	k8sjobs "canette.dev/builder/internal/k8s"
	"canette.dev/builder/internal/store"
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
	encKey, err := requireEnv("ENCRYPTION_KEY")
	if err != nil {
		return err
	}
	cryptoKey, err := crypto.NewKey(encKey)
	if err != nil {
		return fmt.Errorf("ENCRYPTION_KEY: %w", err)
	}

	// ── Database ───────────────────────────────────────────────────────────────
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

	// ── Kubernetes client ──────────────────────────────────────────────────────
	k8sClient, err := buildK8sClient()
	if err != nil {
		return fmt.Errorf("build k8s client: %w", err)
	}

	// ── Build config ───────────────────────────────────────────────────────────
	imageRepo, err := requireEnv("IMAGE_REPO")
	if err != nil {
		return err
	}
	imageRepo = strings.TrimSuffix(imageRepo, "/") + "/"

	builderImage, err := requireEnv("BUILDER_IMAGE")
	if err != nil {
		return err
	}
	gitInitImage, err := requireEnv("GIT_INIT_IMAGE")
	if err != nil {
		return err
	}

	cfg := k8sjobs.BuildConfig{
		Namespace:          envOr("BUILDER_NAMESPACE", "canette-build"),
		ImageRepo:          imageRepo,
		BuildkitdAddr:      envOr("BUILDKITD_ADDR", "tcp://buildkitd.canette-build.svc.cluster.local:1234"),
		BuilderImage:       builderImage,
		GitInitImage:       gitInitImage,
		RegistryAuthSecret: envOr("REGISTRY_AUTH_SECRET", ""),
		TrivyImage:         envOr("TRIVY_IMAGE", "aquasec/trivy:0.51.0"),
	}

	pollInterval, err := time.ParseDuration(envOr("POLL_INTERVAL", "5s"))
	if err != nil {
		return fmt.Errorf("POLL_INTERVAL: %w", err)
	}
	maxConcurrent, err := strconv.Atoi(envOr("MAX_CONCURRENT", "3"))
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

	startHealthServer(ctx, log, envOr("HEALTH_ADDR", ":8081"))

	b := builder.New(
		store.New(db, log),
		k8sClient,
		cfg,
		cryptoKey,
		log,
		pollInterval,
		maxConcurrent,
	)
	return b.Run(ctx)
}

func startHealthServer(ctx context.Context, log *zap.Logger, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health server error", zap.Error(err))
		}
	}()
}

func buildK8sClient() (kubernetes.Interface, error) {
	// Try in-cluster config first (when running as a pod).
	config, err := rest.InClusterConfig()
	if err != nil {
		// Fall back to kubeconfig file.
		kubeconfig := os.Getenv("KUBECONFIG")
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

func requireEnv(key string) (string, error) {
	v := readSecretOrEnv(key)
	if v == "" {
		return "", fmt.Errorf("required environment variable %s is not set", key)
	}
	return v, nil
}

// readSecretOrEnv reads a secret value from a file if <KEY>_FILE is set,
// falling back to the plain environment variable. This supports both the
// Kubernetes file-mount pattern (production) and plain env vars (local dev).
func readSecretOrEnv(key string) string {
	if path := os.Getenv(key + "_FILE"); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return strings.TrimRight(string(data), "\n")
		}
	}
	return os.Getenv(key)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
