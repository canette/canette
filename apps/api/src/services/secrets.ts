import type { DB } from "../db/db"
import type { AppSecret } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { encrypt } from "../utils/crypto"
import { ServiceError } from "./errors"

// ── Internal row type (snake_case, never exported) ────────────────────────────

type SecretRow = Selectable<Database["secrets"]>

// mapSecret intentionally omits encrypted_value — the value is write-only.
function mapSecret(row: SecretRow): AppSecret {
  return {
    id: row.id,
    appId: row.app_id,
    key: row.key,
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

export async function listSecrets(db: DB, appId: string): Promise<AppSecret[]> {
  const rows = await db
    .selectFrom("secrets")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("key", "asc")
    .execute()
  return rows.map(mapSecret)
}

export async function upsertSecret(
  db: DB,
  appId: string,
  key: string,
  value: string
): Promise<AppSecret> {
  if (!isValidKey(key)) {
    throw new ServiceError(
      "Key must be uppercase letters, digits, and underscores, starting with a letter or underscore",
      "VALIDATION_ERROR",
      400
    )
  }

  const encryptedValue = encrypt(value)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db
    .insertInto("secrets")
    .values({ id, app_id: appId, key, encrypted_value: encryptedValue, created_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.columns(["app_id", "key"]).doUpdateSet({ encrypted_value: encryptedValue, updated_at: now })
    )
    .execute()

  const row = await db
    .selectFrom("secrets")
    .selectAll()
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .executeTakeFirstOrThrow()
  return mapSecret(row)
}

export async function deleteSecret(
  db: DB,
  appId: string,
  key: string
): Promise<boolean> {
  const existing = await db
    .selectFrom("secrets")
    .select("id")
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .executeTakeFirst()
  if (!existing) return false

  await db
    .deleteFrom("secrets")
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .execute()
  return true
}
