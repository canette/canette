import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Db } from "../db"
import type { WebhookConfig } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db-types"
import { encrypt, decrypt } from "../crypto"
import { ServiceError } from "./errors"
import { createDeployment } from "./deployments"
import { generateInstallationToken } from "./github-app-token"

// ── Internal row types ────────────────────────────────────────────────────────

type WebhookRow = Selectable<Database["webhook_secrets"]>

interface AppRow {
  id: string
  slug: string
  git_url: string
  git_branch: string
  source_type: string
  git_credential_id: string | null
}

// ── Webhook base URL ──────────────────────────────────────────────────────────

function getWebhookBaseUrl(): string {
  const base = process.env.WEBHOOK_BASE_URL?.trim() ?? ""
  return base ? base.replace(/\/$/, "") : (process.env.UI_URL ?? "http://localhost:3000")
}

// ── Git URL parser ────────────────────────────────────────────────────────────

interface ParsedGitUrl {
  provider: "github" | "gitlab" | "gitea"
  apiBase: string
  owner: string
  repo: string
}

function parseGitUrl(gitUrl: string): ParsedGitUrl | null {
  // Normalise SSH → HTTPS-like form: git@github.com:owner/repo.git → github.com/owner/repo
  const normalised = gitUrl
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")

  let url: URL
  try {
    url = new URL(normalised)
  } catch {
    return null
  }

  const parts = url.pathname.replace(/^\//, "").split("/")
  if (parts.length < 2) return null
  const [owner, repo] = parts
  const host = url.hostname

  if (host === "github.com") {
    return { provider: "github", apiBase: "https://api.github.com", owner, repo }
  }
  if (host === "gitlab.com" || host.includes("gitlab")) {
    return { provider: "gitlab", apiBase: `${url.protocol}//${host}`, owner, repo }
  }
  // Default: treat any other host as Gitea-compatible
  return { provider: "gitea", apiBase: `${url.protocol}//${host}`, owner, repo }
}

// ── Provider auto-registration ────────────────────────────────────────────────

interface AutoRegisterResult {
  autoRegistered: boolean
  providerHookId?: string
  setupInstructions?: string
}

function manualInstructions(parsed: ParsedGitUrl, webhookUrl: string, provider: string): string {
  const scopeHint: Record<string, string> = {
    github: "The PAT needs the `admin:repo_hook` scope (or `write:repo_hook` for fine-grained tokens).",
    gitlab: "The PAT needs the `api` scope.",
    gitea: "The PAT needs the `write:repository` scope.",
  }
  return (
    `Auto-registration failed. Add the webhook manually in your ${provider} repository settings:\n\n` +
    `**URL:** \`${webhookUrl}\`\n` +
    `**Content type:** \`application/json\`\n` +
    `**Secret:** *(shown above — copy it now)*\n\n` +
    (scopeHint[provider] ?? "") +
    `\n\nSee the [canette webhook docs](https://canette.dev/docs/configuration/webhooks) for step-by-step instructions.`
  )
}

async function tryAutoRegister(
  db: Db,
  app: AppRow,
  parsed: ParsedGitUrl,
  webhookUrl: string,
  plaintextSecret: string
): Promise<AutoRegisterResult> {
  // Need a PAT credential to call the provider API. SSH keys don't work here.
  if (!app.git_credential_id) {
    return { autoRegistered: false, setupInstructions: manualInstructions(parsed, webhookUrl, parsed.provider) }
  }

  const cred = await db
    .selectFrom("git_credentials")
    .select(["type", "encrypted_value"])
    .where("id", "=", app.git_credential_id)
    .executeTakeFirst()
  if (!cred || (cred.type !== "pat" && cred.type !== "github_app")) {
    return { autoRegistered: false, setupInstructions: manualInstructions(parsed, webhookUrl, parsed.provider) }
  }

  let pat: string
  try {
    pat = cred.type === "github_app"
      ? await generateInstallationToken()
      : decrypt(cred.encrypted_value)
  } catch (err) {
    console.error("webhook auto-register: failed to obtain token", err)
    return { autoRegistered: false, setupInstructions: manualInstructions(parsed, webhookUrl, parsed.provider) }
  }

  try {
    let hookId: string | number | undefined

    if (parsed.provider === "github") {
      const res = await fetch(
        `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/hooks`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "web",
            active: true,
            events: ["push"],
            config: { url: webhookUrl, content_type: "json", secret: plaintextSecret, insecure_ssl: "0" },
          }),
        }
      )
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`GitHub API ${res.status}: ${body}`)
      }
      const data = await res.json() as { id: number }
      hookId = data.id

    } else if (parsed.provider === "gitlab") {
      const encodedPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
      const res = await fetch(
        `${parsed.apiBase}/api/v4/projects/${encodedPath}/hooks`,
        {
          method: "POST",
          headers: { "PRIVATE-TOKEN": pat, "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, token: plaintextSecret, push_events: true }),
        }
      )
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`GitLab API ${res.status}: ${body}`)
      }
      const data = await res.json() as { id: number }
      hookId = data.id

    } else {
      // Gitea
      const res = await fetch(
        `${parsed.apiBase}/api/v1/repos/${parsed.owner}/${parsed.repo}/hooks`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${pat}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "gitea",
            active: true,
            events: ["push"],
            config: { url: webhookUrl, content_type: "json", secret: plaintextSecret },
          }),
        }
      )
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Gitea API ${res.status}: ${body}`)
      }
      const data = await res.json() as { id: number }
      hookId = data.id
    }

    return { autoRegistered: true, providerHookId: String(hookId) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error("webhook auto-register: provider API error:", detail)
    const instructions = manualInstructions(parsed, webhookUrl, parsed.provider)
    return { autoRegistered: false, setupInstructions: `Auto-registration failed: ${detail}\n\n${instructions}` }
  }
}

async function tryDeregister(parsed: ParsedGitUrl, providerHookId: string, pat: string): Promise<void> {
  try {
    if (parsed.provider === "github") {
      await fetch(
        `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" } }
      )
    } else if (parsed.provider === "gitlab") {
      const encodedPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
      await fetch(
        `${parsed.apiBase}/api/v4/projects/${encodedPath}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { "PRIVATE-TOKEN": pat } }
      )
    } else {
      await fetch(
        `${parsed.apiBase}/api/v1/repos/${parsed.owner}/${parsed.repo}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { Authorization: `token ${pat}` } }
      )
    }
  } catch {
    // Best-effort — don't fail the delete if deregistration fails
  }
}

// ── Public service functions ───────────────────────────────────────────────────

export async function createWebhook(
  db: Db,
  appId: string,
  userId: string,
  opts: { watchPath: string }
): Promise<{
  config: WebhookConfig
  webhookUrl: string
  webhookSecret: string
  autoRegistered: boolean
  setupInstructions?: string
}> {
  // Verify membership
  const accessRow = await db
    .selectFrom("apps as a")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select(["a.id", "a.slug", "a.git_url", "a.git_branch", "a.source_type", "a.git_credential_id"])
    .where("a.id", "=", appId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!accessRow) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const app: AppRow = accessRow
  if (app.source_type !== "git") {
    throw new ServiceError(
      "Webhooks are only supported for git-source apps.",
      "INVALID_SOURCE_TYPE",
      422
    )
  }
  if (!app.git_url) {
    throw new ServiceError("App has no git URL configured.", "MISSING_GIT_URL", 422)
  }

  const parsed = parseGitUrl(app.git_url)
  if (!parsed) {
    throw new ServiceError(
      "Could not parse the app's git URL. Only GitHub, GitLab, and Gitea are supported.",
      "UNSUPPORTED_GIT_URL",
      422
    )
  }

  // Remove any existing webhook for this app (idempotent re-creation)
  await db
    .deleteFrom("webhook_secrets")
    .where("app_id", "=", appId)
    .execute()

  const plaintextSecret = randomBytes(32).toString("hex")
  const encryptedSecret = encrypt(plaintextSecret)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db
    .insertInto("webhook_secrets")
    .values({
      id,
      app_id: appId,
      provider: parsed.provider,
      secret: encryptedSecret,
      watch_path: opts.watchPath,
      created_at: now,
    })
    .execute()

  const webhookUrl = `${getWebhookBaseUrl()}/api/v1/webhooks/app/${appId}`
  const result = await tryAutoRegister(db, app, parsed, webhookUrl, plaintextSecret)

  if (result.providerHookId) {
    await db
      .updateTable("webhook_secrets")
      .set({ provider_hook_id: result.providerHookId })
      .where("id", "=", id)
      .execute()
  }

  return {
    config: { appId, provider: parsed.provider, watchPath: opts.watchPath, autoRegistered: result.autoRegistered, createdAt: now, webhookUrl },
    webhookUrl,
    webhookSecret: plaintextSecret,
    autoRegistered: result.autoRegistered,
    setupInstructions: result.setupInstructions,
  }
}

export async function getWebhook(
  db: Db,
  appId: string,
  userId: string
): Promise<WebhookConfig | null> {
  const access = await db
    .selectFrom("apps as a")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select("a.id")
    .where("a.id", "=", appId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!access) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("webhook_secrets")
    .selectAll()
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!row) return null

  const baseUrl = getWebhookBaseUrl()
  return {
    appId: row.app_id,
    provider: row.provider,
    watchPath: row.watch_path,
    autoRegistered: row.provider_hook_id !== null,
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
    webhookUrl: `${baseUrl}/api/v1/webhooks/app/${appId}`,
  }
}

export async function deleteWebhook(
  db: Db,
  appId: string,
  userId: string
): Promise<boolean> {
  const accessRow = await db
    .selectFrom("apps as a")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select(["a.git_url", "a.git_credential_id"])
    .where("a.id", "=", appId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!accessRow) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("webhook_secrets")
    .selectAll()
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!row) return false

  // Best-effort deregistration from provider
  if (row.provider_hook_id && accessRow.git_credential_id) {
    const parsed = parseGitUrl(accessRow.git_url)
    if (parsed) {
      const cred = await db
        .selectFrom("git_credentials")
        .select(["type", "encrypted_value"])
        .where("id", "=", accessRow.git_credential_id)
        .executeTakeFirst()
      if (cred?.type === "pat" || cred?.type === "github_app") {
        try {
          const pat = cred.type === "github_app"
            ? await generateInstallationToken()
            : decrypt(cred.encrypted_value)
          await tryDeregister(parsed, row.provider_hook_id, pat)
        } catch {
          // Best-effort — don't fail the delete if token generation fails
        }
      }
    }
  }

  await db
    .deleteFrom("webhook_secrets")
    .where("app_id", "=", appId)
    .execute()
  return true
}

// ── Webhook event processing (called by the public receiver route) ─────────────

export async function processWebhookEvent(
  db: Db,
  appId: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>
): Promise<{ status: number; message: string }> {
  const row = await db
    .selectFrom("webhook_secrets as ws")
    .innerJoin("apps as a", "a.id", "ws.app_id")
    .selectAll("ws")
    .select("a.git_branch")
    .where("ws.app_id", "=", appId)
    .executeTakeFirst()
  if (!row) return { status: 404, message: "No webhook configured for this app" }

  const plaintextSecret = decrypt(row.secret)

  // ── Signature validation ──────────────────────────────────────────────────
  if (row.provider === "github" || row.provider === "gitea") {
    const headerName = row.provider === "github" ? "x-hub-signature-256" : "x-gitea-signature"
    const sigHeader = headers[headerName] ?? ""
    const expected = "sha256=" + createHmac("sha256", plaintextSecret).update(rawBody).digest("hex")
    // header should be "sha256=" + 64 char signature
    if (sigHeader.length !== 71) {
      return { status: 401, message: "Invalid signature" }
    }
    if (!timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))) {
      return { status: 401, message: "Invalid signature" }
    }
  } else if (row.provider === "gitlab") {
    const token = headers["x-gitlab-token"] ?? ""
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(plaintextSecret))) {
      return { status: 401, message: "Invalid token" }
    }
  } else {
    return { status: 500, message: "Unknown provider" }
  }

  // ── Ping event (GitHub / Gitea) ───────────────────────────────────────────
  const eventHeader = headers["x-github-event"] ?? headers["x-gitea-event"] ?? ""
  if (eventHeader === "ping") {
    // Set - or update - verified timestamp
    await db
      .updateTable("webhook_secrets")
      .set({ verified_at: new Date().toISOString() })
      .where("app_id", "=", appId)
      .execute()
    return { status: 200, message: "Pong" }
  }

  // ── Mark as verified on first successful event ────────────────────────────
  if (!row.verified_at) {
    await db
      .updateTable("webhook_secrets")
      .set({ verified_at: new Date().toISOString() })
      .where("app_id", "=", appId)
      .execute()
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return { status: 400, message: "Invalid JSON payload" }
  }

  const ref = (payload.ref as string | undefined) ?? ""
  const pushedBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref

  let headCommitSha: string
  let headCommitMessage: string | undefined
  let changedFiles: string[]

  if (row.provider === "gitlab") {
    headCommitSha = (payload.after as string | undefined) ?? ""
    const commits = (payload.commits as Array<{ message?: string; added?: string[]; modified?: string[]; removed?: string[] }> | undefined) ?? []
    headCommitMessage = commits[0]?.message
    changedFiles = commits.flatMap(c => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])])
  } else {
    const hc = payload.head_commit as Record<string, unknown> | undefined
    headCommitSha = (hc?.id as string | undefined) ?? ""
    headCommitMessage = hc?.message as string | undefined
    const commits = (payload.commits as Array<{ added?: string[]; modified?: string[]; removed?: string[] }> | undefined) ?? []
    changedFiles = commits.flatMap(c => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])])
  }

  if (!headCommitSha) return { status: 200, message: "No commit SHA in payload" }

  // ── Branch filter ─────────────────────────────────────────────────────────
  if (pushedBranch !== row.git_branch) {
    return { status: 200, message: "Branch not tracked" }
  }

  // ── Path filter ───────────────────────────────────────────────────────────
  if (row.watch_path) {
    const prefix = row.watch_path.endsWith("/") ? row.watch_path : row.watch_path + "/"
    const relevant = changedFiles.some(f => f.startsWith(prefix) || f === row.watch_path)
    if (!relevant) return { status: 200, message: "No changes under watch_path" }
  }

  // ── App state check ───────────────────────────────────────────────────────
  const latest = await db
    .selectFrom("deployments")
    .select("status")
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()
  const latestStatus = latest?.status
  if (!latestStatus || latestStatus === "stopped") {
    return { status: 200, message: "App is not running — push acknowledged but no deployment triggered" }
  }
  if (["pending", "building", "scanning", "deploying"].includes(latestStatus)) {
    return { status: 200, message: "Deployment already in progress" }
  }
  // ── Trigger deployment ────────────────────────────────────────────────────
  await createDeployment(db, appId, null, {
    commitSha: headCommitSha,
    commitMessage: headCommitMessage,
  })

  return { status: 200, message: "Deployment triggered" }
}
