// Internal-only port the password-gate Caddy sidecar listens on. Must stay in
// sync with apps/controller/internal/k8s/resources.go's caddySidecarPort
// constant — the Service's targetPort switches to this value when the gate is
// enabled. Apps may never declare this as their own runtime port (see the
// createApp/updateApp port validation in ./apps.ts).
export const CADDY_SIDECAR_PORT = 39191
