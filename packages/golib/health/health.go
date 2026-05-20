// Package health provides a minimal HTTP health check server.
package health

import (
	"context"
	"errors"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// StartServer starts a /healthz endpoint on addr and shuts it down when ctx is cancelled.
func StartServer(ctx context.Context, log *zap.Logger, addr string) {
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
