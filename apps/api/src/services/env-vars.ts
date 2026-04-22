import type { Db } from "../db"
import type { EnvVar } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db-types"
import { ServiceError } from "./errors"

// ── Internal row type (snake_case, never exported) ────────────────────────────

type EnvVarRow = Selectable<Database["env_vars"]>

function mapEnvVar(row: EnvVarRow): EnvVar {
  return {
    id: row.id,
    appId: row.app_id,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Key validation ────────────────────────────────────────────────────────────

function isValidKey(key: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(key)
}

// ── Service functions ─────────────────────────────────────────────────────────
// Callers must verify app access (via getAppById) before calling these.

export async function listEnvVars(db: Db, appId: string): Promise<EnvVar[]> {
  const rows = await db
    .selectFrom("env_vars")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("key", "asc")
    .execute()
  return rows.map(mapEnvVar)
}

export async function upsertEnvVar(
  db: Db,
  appId: string,
  key: string,
  value: string
): Promise<EnvVar> {
  if (!isValidKey(key)) {
    throw new ServiceError(
      "Key must be uppercase letters, digits, and underscores, starting with a letter or underscore",
      "VALIDATION_ERROR",
      400
    )
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db
    .insertInto("env_vars")
    .values({ id, app_id: appId, key, value, created_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.columns(["app_id", "key"]).doUpdateSet({ value, updated_at: now })
    )
    .execute()

  const row = await db
    .selectFrom("env_vars")
    .selectAll()
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .executeTakeFirstOrThrow()
  return mapEnvVar(row)
}

export async function deleteEnvVar(
  db: Db,
  appId: string,
  key: string
): Promise<boolean> {
  const existing = await db
    .selectFrom("env_vars")
    .select("id")
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .executeTakeFirst()
  if (!existing) return false

  await db
    .deleteFrom("env_vars")
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .execute()
  return true
}
