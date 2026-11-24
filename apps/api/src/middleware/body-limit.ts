import type { Context, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"

const MiB = 1024 * 1024

// Hard ceiling enforced by Bun before any handler runs (maxRequestBodySize in
// index.ts). Slightly above the largest per-route limit below, so the route
// limits are what callers normally hit, with a JSON error body.
export const MAX_REQUEST_BODY_SIZE = 30 * MiB

// Every route that has no reason to accept more. Templates (50 KB), env values
// (10 KB) and the OAuth/auth forms are all far below this.
export const DEFAULT_BODY_LIMIT = 1 * MiB

// Volumes and MCP carry ConfigMap content, which may be up to 1 MiB before
// JSON escaping (see CONFIGMAP_MAX_BYTES in services/volumes.ts).
export const LARGE_BODY_LIMIT = 8 * MiB

// GitHub caps webhook payloads at 25 MB; GitLab and Gitea stay well below.
export const WEBHOOK_BODY_LIMIT = 25 * MiB

// Rejects declared (Content-Length) and chunked bodies over maxSize with 413.
// Chunked bodies are counted while they are read, so an oversized one is
// never buffered in full.
export function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c: Context) =>
      c.json({ error: `Request body exceeds the ${maxSize / MiB} MiB limit`, code: "PAYLOAD_TOO_LARGE" }, 413),
  })
}

const VOLUMES_PATH = /^\/api\/v1\/apps\/[^/]+\/volumes(\/|$)/

// requestBodyLimit applies the per-route limit to every request. Webhook
// receivers are skipped here: their router applies WEBHOOK_BODY_LIMIT itself,
// after the app lookup, so a delivery for an unknown app is rejected before
// its body is read.
export function requestBodyLimit(): MiddlewareHandler {
  const defaultLimit = limitBody(DEFAULT_BODY_LIMIT)
  const largeLimit = limitBody(LARGE_BODY_LIMIT)
  return (c, next) => {
    const path = c.req.path
    if (path.startsWith("/api/v1/webhooks/")) return next()
    if (path === "/mcp" || path.startsWith("/mcp/") || VOLUMES_PATH.test(path)) return largeLimit(c, next)
    return defaultLimit(c, next)
  }
}
