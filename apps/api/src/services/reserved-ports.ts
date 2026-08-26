// Internal-only port the password-gate authgate sidecar listens on. Must stay
// in sync with apps/controller/internal/k8s/resources.go's
// authgateSidecarPort constant — the Service's targetPort switches to this
// value when the gate is enabled. Apps may never declare this as their own
// runtime port (see the createApp/updateApp port validation in ./apps.ts).
export const AUTHGATE_SIDECAR_PORT = 39191
