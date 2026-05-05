import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { auth } from "./auth/auth"
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

    // Block email sign-up when disabled via DISABLE_EMAIL_SIGNUP env var.
    // Must be registered before the better-auth catch-all so Hono matches it first.
    if (process.env.DISABLE_EMAIL_SIGNUP === "true") {
    app.post("/api/auth/sign-up/email", (c) =>
        c.json({ error: "Sign-up is disabled on this instance", code: "SIGNUP_DISABLED" }, 403),
    )
    }

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

    // OAuth 2.1 AS and MCP (unauthenticated at router level — bearer auth applied in mcpRouter)
    app.route("/.well-known", wellKnownRouter)
    app.route("/oauth", oauthRouter)
    app.route("/mcp", mcpRouter)

    app.get("/healthz", (c) => c.json({ ok: true }))

    return app;
}