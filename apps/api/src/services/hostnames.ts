import type { DB } from "../db/db"
import type { AppHostname } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { ServiceError } from "./errors"

// ── Internal row type ─────────────────────────────────────────────────────────

type HostnameRow = Selectable<Database["app_hostnames"]>

function mapHostname(row: HostnameRow): AppHostname {
  return {
    id: row.id,
    appId: row.app_id,
    hostname: row.hostname,
    createdAt: row.created_at,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

// Standard DNS label rules: 1-63 chars, alphanumeric + hyphen, no leading/trailing
// hyphen; at least two labels (a TLD is required). Overall length capped at 253.
const FQDN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function validateHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase()
  if (!FQDN_RE.test(hostname)) {
    throw new ServiceError(
      `'${raw}' is not a valid hostname — use a fully-qualified domain name (e.g. 'app.example.com')`,
      "VALIDATION_ERROR",
      400
    )
  }
  return hostname
}

function isUniqueConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : ""
  return msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("duplicate key")
}

// Plain, non-team-scoped app lookup, used by the mutating (add/delete) paths only —
// the list route uses getAppById instead, since reading is team-scoped. Unlike
// getAppById, this does NOT join team_members — the add/delete routes are gated
// purely by the global requireAdmin middleware, so a caller who is a platform
// admin but not a member of the app's team must still be able to manage its
// hostnames. Do not swap this for getAppById in addHostname/deleteHostname.
async function getAppForAdmin(
  db: DB,
  appId: string
): Promise<{ id: string; slug: string; deploymentType: string } | null> {
  const row = await db
    .selectFrom("apps")
    .select(["id", "slug", "deployment_type"])
    .where("id", "=", appId)
    .executeTakeFirst()
  if (!row) return null
  return { id: row.id, slug: row.slug, deploymentType: row.deployment_type }
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function listHostnames(db: DB, appId: string): Promise<AppHostname[]> {
  const rows = await db
    .selectFrom("app_hostnames")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "asc")
    .execute()
  return rows.map(mapHostname)
}

export async function addHostname(db: DB, appId: string, rawHostname: string): Promise<AppHostname> {
  const app = await getAppForAdmin(db, appId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  if (app.deploymentType !== "web") {
    throw new ServiceError("Custom hostnames are only supported for web apps", "VALIDATION_ERROR", 422)
  }

  const hostname = validateHostname(rawHostname)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await db
      .insertInto("app_hostnames")
      .values({ id, app_id: appId, hostname, created_at: now })
      .execute()
  } catch (e: unknown) {
    if (isUniqueConstraintError(e)) {
      throw new ServiceError(`Hostname '${hostname}' is already assigned to another app`, "CONFLICT", 409)
    }
    throw e
  }

  const row = await db.selectFrom("app_hostnames").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
  return mapHostname(row)
}

export async function deleteHostname(db: DB, appId: string, hostnameId: string): Promise<void> {
  const app = await getAppForAdmin(db, appId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("app_hostnames")
    .selectAll()
    .where("id", "=", hostnameId)
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!row) throw new ServiceError("Not found", "NOT_FOUND", 404)

  await db.deleteFrom("app_hostnames").where("id", "=", hostnameId).execute()
}
