// Env var / secret keys the platform injects itself and a user must never be
// able to set — doing so would create a duplicate entry in the container's
// env list, which the controller's server-side apply rejects outright (see
// GetAppConfig in apps/controller/internal/store/store.go, which also strips
// PORT defensively in case it slips in via a committed canette.yaml).
export const RESERVED_ENV_KEYS = new Set(["PORT"])
