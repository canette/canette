// Command authgate is the per-app password-gate sidecar. It sits in front of
// an app's own container on localhost and gates access with either a browser
// login form (session cookie) or HTTP Basic Auth (scripts, webhooks, CI).
//
// It replaces the earlier caddy:2-alpine + basic_auth sidecar: same job (gate
// one app's traffic with the username/password stored in
// apps.password_gate_*), same wiring (Secret-mounted credentials, Service
// targetPort switches to this container when the gate is enabled), but with a
// branded no-JS login page for browsers instead of the native Basic Auth
// dialog. Verifies the exact bcrypt hash apps/api/src/services/password-gate.ts
// already produces — no change to the API layer or DB schema.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"go.uber.org/zap"

	"canette.dev/lib/env"
)

func main() {
	logLevel := os.Getenv("LOG_LEVEL")
	zapCfg := zap.NewProductionConfig()
	if err := zapCfg.Level.UnmarshalText([]byte(logLevel)); err != nil {
		zapCfg.Level.SetLevel(zap.InfoLevel)
	}
	log, _ := zapCfg.Build()
	defer func() { _ = log.Sync() }()

	log.Info("canette authgate starting")

	if err := run(log); err != nil {
		log.Fatal("authgate error", zap.Error(err))
	}
}

func run(log *zap.Logger) error {
	// ── .env file (local dev only) ────────────────────────────────────────────
	if _, err := os.Stat(".env"); err == nil {
		_ = godotenv.Load()
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	gate := newGate(log, cfg)

	addr := env.EnvOr("AUTHGATE_LISTEN_ADDR", ":39191")
	srv := &http.Server{
		Addr:              addr,
		Handler:           gate.mux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Info("authgate listening", zap.String("addr", addr), zap.String("app", cfg.AppSlug))
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// config holds the sidecar's runtime configuration, sourced entirely from env
// vars — the password hash arrives as a plain env var via the container's
// envFrom.secretRef (see apps/controller/internal/k8s/resources.go), not a
// mounted config file, so there is no config-syntax injection surface to
// guard against the way the old rendered Caddyfile had to.
//
// There is no username field: this gates one shared password, not individual
// accounts (there is no apps.password_gate_username column either — dropped
// in migration 000014). The browser login form only ever asked for a
// password; Basic Auth accepts any username alongside the correct password
// to match.
type config struct {
	PasswordHash string // bcrypt hash, e.g. "$2b$10$..." — never a plaintext password
	UpstreamPort string
	AppSlug      string
}

func loadConfig() (config, error) {
	passwordHash, err := env.RequireEnv("AUTHGATE_PASSWORD_HASH")
	if err != nil {
		return config{}, err
	}
	upstreamPort, err := env.RequireEnv("AUTHGATE_UPSTREAM_PORT")
	if err != nil {
		return config{}, err
	}
	return config{
		PasswordHash: passwordHash,
		UpstreamPort: upstreamPort,
		AppSlug:      env.EnvOr("AUTHGATE_APP_SLUG", ""),
	}, nil
}

func (c config) upstreamOrigin() string {
	return fmt.Sprintf("http://localhost:%s", c.UpstreamPort)
}
