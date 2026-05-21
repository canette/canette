import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { auth, emailProviderConfigured } from "./auth/auth"
import { db } from "./db/db"
import { getSignupMode } from "./services/admin"
import { projectsRouter } from "./routes/projects"
import { teamsRouter } from "./routes/teams"
import { appsRouter } from "./routes/apps"
import { envRouter } from "./routes/env"
import { appLogsRouter } from "./routes/app-logs"
import { appLogsStreamRouter } from "./routes/app-logs-stream"
import { webhooksRouter } from "./routes/webhooks"
import { webhookReceiverRouter } from "./routes/webhook-receiver"
import { adminRouter } from "./routes/admin"
import { usersRouter } from "./routes/users"
import { githubAppRouter } from "./routes/github-app"
import { wellKnownRouter, oauthRouter } from "./routes/oauth"
import { mcpRouter } from "./routes/mcp"
import { templatesRouter } from "./routes/templates"

export function createApp() {
    const app = new Hono()

    app.use("*", logger())

    // OAuth and MCP endpoints are public (bearer token auth, no cookies).
    // Must be registered before the session-cookie CORS below so that OPTIONS
    // preflights short-circuit here and don't get the restrictive UI origin.
    const mcpCors = cors({
        origin: "*",
        allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    })
    app.use("/mcp", mcpCors)
    app.use("/mcp/*", mcpCors)
    app.use("/.well-known/*", mcpCors)
    app.use("/oauth/*", mcpCors)

    app.use(
    "*",
    cors({
        origin: process.env.UI_URL ?? "http://localhost:3000",
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
    }),
    )

    // Public: what signup mode is active and whether magic link is available.
    // Must be before auth middleware so the login page can read it unauthenticated.
    app.get("/api/v1/signup-settings", async (c) => {
      if (process.env.DISABLE_EMAIL_SIGNUP === "true") {
        return c.json({ mode: "disabled", magicLinkEnabled: emailProviderConfigured })
      }
      const raw = await getSignupMode(db)
      const mode = raw === "open" || raw === "disabled" ? raw : "invite_code"
      return c.json({ mode, magicLinkEnabled: emailProviderConfigured })
    })

    // Signup interceptor — always registered before better-auth's catch-all.
    // DISABLE_EMAIL_SIGNUP (Helm) is a hard override that cannot be changed at runtime.
    //
    // The body is buffered immediately before any await. In Bun, the request body
    // stream is tied to the active read; awaiting an async operation (e.g. a DB call)
    // before reading the body marks the stream as used, causing better-auth to fail
    // with ERR_BODY_ALREADY_USED. Buffering first and reconstructing the Request
    // lets better-auth read the body normally.
    app.post("/api/auth/sign-up/email", async (c) => {
      const bodyText = await c.req.raw.text().catch(() => "")

      if (process.env.DISABLE_EMAIL_SIGNUP === "true") {
        return c.json({ error: "Sign-up is disabled on this instance", code: "SIGNUP_DISABLED" }, 403)
      }
      const mode = await getSignupMode(db)
      if (mode === "disabled") {
        return c.json({ error: "Sign-up is disabled on this instance", code: "SIGNUP_DISABLED" }, 403)
      }
      if (mode !== "open") {
        const body = JSON.parse(bodyText || "{}") as Record<string, unknown>
        if (body.inviteCode !== mode) {
          return c.json({ error: "Invalid invite code", code: "INVALID_INVITE_CODE" }, 403)
        }
      }
      const req = new Request(c.req.raw, { body: bodyText })
      return auth.handler(req)
    })

    // better-auth handles all /api/auth/** routes
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

    // public webhooks before auth
    app.route("/api/v1/webhooks", webhookReceiverRouter)

    // Application routes
    const api = app.basePath("/api/v1")
    api.route("/projects", projectsRouter)
    api.route("/teams", teamsRouter)
    api.route("/", appsRouter)
    api.route("/", envRouter)
    api.route("/", appLogsRouter)
    api.route("/", appLogsStreamRouter)
    api.route("/", webhooksRouter)
    api.route("/admin", adminRouter)
    api.route("/users", usersRouter)
    api.route("/github-app", githubAppRouter)
    api.route("/", templatesRouter)

    // OAuth 2.1 AS and MCP (unauthenticated at router level — bearer auth applied in mcpRouter)
    app.route("/.well-known", wellKnownRouter)
    app.route("/oauth", oauthRouter)
    app.route("/mcp", mcpRouter)

    app.get("/healthz", (c) => c.json({ ok: true }))

    return app;
}