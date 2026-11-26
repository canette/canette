import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { DB } from "../db/db"
import type { WebhookConfig } from "@canette/types"
import { encrypt, decrypt } from "../utils/crypto"
import { ServiceError } from "./errors"
import { createDeployment } from "./deployments"
import { generateInstallationToken } from "./github-app-token"
import { ALLOWED_ORIGINS_ENV, isAdminAllowedOrigin, normaliseHttpsOrigin } from "./git-credential-destination"

// ── Internal row types ────────────────────────────────────────────────────────

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

interface WebhookCredential {
  provider: string
  type: string
  encrypted_value: string
  installation_id: string | null
}

const BUILTIN_WEBHOOK_API_ORIGINS = new Set([
  "https://api.github.com",
  "https://gitlab.com",
])

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000
const PROVIDER_RESPONSE_LIMIT_BYTES = 64 * 1024

function isApprovedWebhookApiOrigin(apiBase: string): boolean {
  const origin = normaliseHttpsOrigin(apiBase)
  if (!origin) return false
  return BUILTIN_WEBHOOK_API_ORIGINS.has(origin) || isAdminAllowedOrigin(origin)
}

function credentialMatchesDestination(
  credential: Pick<WebhookCredential, "provider" | "type">,
  parsed: ParsedGitUrl,
): boolean {
  // GitHub App tokens are only valid for, and must only ever be sent to, GitHub.
  if (credential.type === "github_app" && credential.provider !== "github") return false

  return credential.provider === parsed.provider && isApprovedWebhookApiOrigin(parsed.apiBase)
}

function providerRequest(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    // Never forward credential-bearing headers to a redirect destination.
    redirect: "error",
    signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
  })
}

async function readProviderJson<T>(response: Response): Promise<T> {
  if (!response.body) throw new Error("Provider API returned an empty response")

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PROVIDER_RESPONSE_LIMIT_BYTES) {
      await reader.cancel()
      throw new Error("Provider API response exceeded 64 KB")
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as T
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
    return { provider: "gitlab", apiBase: `${url.protocol}//${url.host}`, owner, repo }
  }
  // Default: treat any other host as Gitea-compatible
  return { provider: "gitea", apiBase: `${url.protocol}//${url.host}`, owner, repo }
}

// ── Provider auto-registration ────────────────────────────────────────────────

interface AutoRegisterResult {
  autoRegistered: boolean
  providerHookId?: string
  setupInstructions?: string
  // Why auto-registration didn't happen, in one sentence for the user.
  failureReason?: string
}

const SCOPE_HINTS: Record<string, string> = {
  github: "The PAT needs the `admin:repo_hook` scope (or `write:repo_hook` for fine-grained tokens).",
  gitlab: "The PAT needs the `api` scope.",
  gitea: "The PAT needs the `write:repository` scope.",
}

function manualInstructions(parsed: ParsedGitUrl, webhookUrl: string, provider: string): string {
  return (
    `Auto-registration failed. Add the webhook manually in your ${provider} repository settings:\n\n` +
    `**URL:** \`${webhookUrl}\`\n` +
    `**Content type:** \`application/json\`\n` +
    `**Secret:** *(shown above — copy it now)*\n\n` +
    (SCOPE_HINTS[provider] ?? "") +
    `\n\nSee the [canette webhook docs](https://canette.dev/docs/getting-started/webhooks) for step-by-step instructions.`
  )
}

type AutoRegisterCredential =
  | { ok: true; credential: WebhookCredential }
  | { ok: false; reason: string }

// The checks that can be made without calling the provider: the app needs a
// token-type credential that may be sent to the provider's API. Whether the
// token has the permissions it needs only shows when the provider is called.
async function autoRegisterCredential(db: DB, app: AppRow, parsed: ParsedGitUrl): Promise<AutoRegisterCredential> {
  if (!app.git_credential_id) {
    return { ok: false, reason: `The app has no Git credential, so canette can't register the webhook with ${parsed.provider} itself.` }
  }

  const cred = await db
    .selectFrom("git_credentials")
    .select(["provider", "type", "encrypted_value", "installation_id"])
    .where("id", "=", app.git_credential_id)
    .executeTakeFirst()
  // Need a PAT credential to call the provider API. SSH keys don't work here.
  if (!cred || (cred.type !== "pat" && cred.type !== "github_app")) {
    return {
      ok: false,
      reason: `The app's Git credential is not a personal access token or GitHub App, so canette can't call the ${parsed.provider} API to register the webhook.`,
    }
  }
  // Enforce the credential's provider and the administrator-approved API origin
  // before decrypting a PAT or minting a GitHub installation token.
  if (!credentialMatchesDestination(cred, parsed)) {
    return {
      ok: false,
      reason:
        `Auto-registration is disabled for ${parsed.apiBase}: the app's git credential can only be ` +
        `sent to its provider's public API or to hosts an administrator has allowed via ` +
        `${ALLOWED_ORIGINS_ENV}.`,
    }
  }
  return { ok: true, credential: cred }
}

async function tryAutoRegister(
  db: DB,
  app: AppRow,
  parsed: ParsedGitUrl,
  webhookUrl: string,
  plaintextSecret: string
): Promise<AutoRegisterResult> {
  const check = await autoRegisterCredential(db, app, parsed)
  if (!check.ok) {
    return {
      autoRegistered: false,
      failureReason: check.reason,
      setupInstructions: `${check.reason}\n\n${manualInstructions(parsed, webhookUrl, parsed.provider)}`,
    }
  }
  const cred = check.credential

  let pat: string
  try {
    pat = cred.type === "github_app"
      ? await generateInstallationToken(cred.installation_id ?? undefined)
      : decrypt(cred.encrypted_value)
  } catch (err) {
    console.error("webhook auto-register: failed to obtain token", err)
    return {
      autoRegistered: false,
      failureReason: "canette could not obtain a token from the app's Git credential.",
      setupInstructions: manualInstructions(parsed, webhookUrl, parsed.provider),
    }
  }

  try {
    let hookId: string | number | undefined

    if (parsed.provider === "github") {
      const res = await providerRequest(
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
        throw new Error(`GitHub API ${res.status}`)
      }
      const data = await readProviderJson<{ id: number }>(res)
      hookId = data.id

    } else if (parsed.provider === "gitlab") {
      const encodedPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
      const res = await providerRequest(
        `${parsed.apiBase}/api/v4/projects/${encodedPath}/hooks`,
        {
          method: "POST",
          headers: { "PRIVATE-TOKEN": pat, "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, token: plaintextSecret, push_events: true }),
        }
      )
      if (!res.ok) {
        throw new Error(`GitLab API ${res.status}`)
      }
      const data = await readProviderJson<{ id: number }>(res)
      hookId = data.id

    } else {
      // Gitea
      const res = await providerRequest(
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
        throw new Error(`Gitea API ${res.status}`)
      }
      const data = await readProviderJson<{ id: number }>(res)
      hookId = data.id
    }

    return { autoRegistered: true, providerHookId: String(hookId) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error("webhook auto-register: provider API error:", detail)
    const instructions = manualInstructions(parsed, webhookUrl, parsed.provider)
    return {
      autoRegistered: false,
      failureReason: `Registering the webhook with the ${parsed.provider} API failed (${detail}). ${SCOPE_HINTS[parsed.provider] ?? ""}`.trim(),
      setupInstructions: `Auto-registration failed: ${detail}\n\n${instructions}`,
    }
  }
}

async function tryDeregister(parsed: ParsedGitUrl, providerHookId: string, pat: string): Promise<void> {
  try {
    if (parsed.provider === "github") {
      await providerRequest(
        `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" } }
      )
    } else if (parsed.provider === "gitlab") {
      const encodedPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`)
      await providerRequest(
        `${parsed.apiBase}/api/v4/projects/${encodedPath}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { "PRIVATE-TOKEN": pat } }
      )
    } else {
      await providerRequest(
        `${parsed.apiBase}/api/v1/repos/${parsed.owner}/${parsed.repo}/hooks/${providerHookId}`,
        { method: "DELETE", headers: { Authorization: `token ${pat}` } }
      )
    }
  } catch {
    // Best-effort — don't fail the delete if deregistration fails
  }
}

// ── Public service functions ───────────────────────────────────────────────────

interface WebhookTarget {
  app: AppRow
  parsed: ParsedGitUrl
}

// The app a webhook can be created for, after the team-access check. Throws
// for an app whose source can't have a webhook.
async function resolveWebhookTarget(db: DB, appId: string, userId: string): Promise<WebhookTarget> {
  const accessRow = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select(["a.id", "a.slug", "a.git_url", "a.git_branch", "a.source_type", "a.git_credential_id"])
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
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
  return { app, parsed }
}

export interface WebhookSupport {
  provider: ParsedGitUrl["provider"]
  // Whether createWebhook can register the webhook with the provider itself.
  // true is not a guarantee: the provider can still refuse the token.
  autoRegister: { possible: true } | { possible: false; reason: string }
}

// What createWebhook would do for this app, without changing anything. Throws
// like createWebhook for an app that can't have a webhook.
export async function checkWebhookSupport(db: DB, appId: string, userId: string): Promise<WebhookSupport> {
  const { app, parsed } = await resolveWebhookTarget(db, appId, userId)
  const check = await autoRegisterCredential(db, app, parsed)
  return {
    provider: parsed.provider,
    autoRegister: check.ok ? { possible: true } : { possible: false, reason: check.reason },
  }
}

// Best-effort removal of a webhook canette registered with the provider.
async function deregisterProviderHook(
  db: DB,
  app: Pick<AppRow, "git_url" | "git_credential_id">,
  providerHookId: string
): Promise<void> {
  if (!app.git_credential_id) return
  const parsed = parseGitUrl(app.git_url)
  if (!parsed) return
  const cred = await db
    .selectFrom("git_credentials")
    .select(["provider", "type", "encrypted_value", "installation_id"])
    .where("id", "=", app.git_credential_id)
    .executeTakeFirst()
  if (
    (cred?.type === "pat" || cred?.type === "github_app") &&
    credentialMatchesDestination(cred, parsed)
  ) {
    try {
      const pat = cred.type === "github_app"
        ? await generateInstallationToken(cred.installation_id ?? undefined)
        : decrypt(cred.encrypted_value)
      await tryDeregister(parsed, providerHookId, pat)
    } catch {
      // Best-effort — don't fail the delete if token generation fails
    }
  }
}

export async function createWebhook(
  db: DB,
  appId: string,
  userId: string,
  opts: { watchPath: string }
): Promise<{
  config: WebhookConfig
  webhookUrl: string
  webhookSecret: string
  autoRegistered: boolean
  setupInstructions?: string
  autoRegisterFailureReason?: string
}> {
  const { app, parsed } = await resolveWebhookTarget(db, appId, userId)

  // Replacing a webhook rotates its secret, so the hook canette registered for
  // the old one would only fail signature checks from now on.
  const existing = await db
    .selectFrom("webhook_secrets")
    .select("provider_hook_id")
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (existing?.provider_hook_id) await deregisterProviderHook(db, app, existing.provider_hook_id)

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
    autoRegisterFailureReason: result.failureReason,
  }
}

export async function getWebhook(
  db: DB,
  appId: string,
  userId: string
): Promise<WebhookConfig | null> {
  const access = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select("a.id")
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
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
  db: DB,
  appId: string,
  userId: string
): Promise<boolean> {
  const accessRow = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p_access", "p_access.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p_access.team_id")
    .select(["a.git_url", "a.git_credential_id"])
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!accessRow) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("webhook_secrets")
    .selectAll()
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!row) return false

  // Best-effort deregistration from provider
  if (row.provider_hook_id) await deregisterProviderHook(db, accessRow, row.provider_hook_id)

  await db
    .deleteFrom("webhook_secrets")
    .where("app_id", "=", appId)
    .execute()
  return true
}

// ── Webhook event processing (called by the public receiver route) ─────────────

export async function hasWebhook(db: DB, appId: string): Promise<boolean> {
  const row = await db
    .selectFrom("webhook_secrets")
    .select("app_id")
    .where("app_id", "=", appId)
    .executeTakeFirst()
  return row !== undefined
}

const NOT_RUNNING_MESSAGE = "App is not running — push acknowledged but no deployment triggered"

export async function processWebhookEvent(
  db: DB,
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
  // A push deploys only an app that should be running: one deployed and not
  // stopped since. Its intent says so (#354). A stopped app's latest
  // deployment can be superseded rather than stopped, so its status doesn't.
  const intent = await db
    .selectFrom("app_intents")
    .select("desired_state")
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (intent?.desired_state !== "running") {
    return { status: 200, message: NOT_RUNNING_MESSAGE }
  }
  // ── Trigger deployment ────────────────────────────────────────────────────
  // A deployment still in progress doesn't hold the push back: the new one
  // supersedes it, so the newest push is what goes live (#354).
  try {
    await createDeployment(db, appId, null, {
      commitSha: headCommitSha,
      commitMessage: headCommitMessage,
      onlyIfRunning: true,
    })
  } catch (err) {
    // Stopped since the check above: the Stop wins.
    if (err instanceof ServiceError && err.code === "APP_NOT_RUNNING") {
      return { status: 200, message: NOT_RUNNING_MESSAGE }
    }
    throw err
  }

  return { status: 200, message: "Deployment triggered" }
}
