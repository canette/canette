import type { DB } from "../db/db"
import type { AppSecret } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { encrypt } from "../utils/crypto"
import { ServiceError } from "./errors"
import { RESERVED_ENV_KEYS } from "./reserved-env-keys"

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

// Throws a ServiceError when key can't be used as a secret name.
export function validateSecretKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new ServiceError(
      "Key must be uppercase letters, digits, and underscores, starting with a letter or underscore",
      "VALIDATION_ERROR",
      400
    )
  }
  if (RESERVED_ENV_KEYS.has(key)) {
    throw new ServiceError(
      `${key} is set automatically by canette and can't be overridden — configure the runtime port instead`,
      "RESERVED_KEY",
      400
    )
  }
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
  value: string,
  opts: { replaceEnvVar?: boolean } = {}
): Promise<AppSecret> {
  validateSecretKey(key)

  const encryptedValue = encrypt(value)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  return await db.transaction().execute(async (tx) => {
    // A secret must never shadow a plain env var of the same name (the
    // reverse is checked in upsertEnvVar). Converting one deletes the plain
    // value in the same transaction.
    const envVar = await tx
      .selectFrom("env_vars")
      .select("id")
      .where("app_id", "=", appId)
      .where("key", "=", key)
      .executeTakeFirst()
    if (envVar) {
      if (!opts.replaceEnvVar) {
        throw new ServiceError(
          `${key} is set as a plain environment variable on this app — convert it to a secret to replace it`,
          "CONFLICT",
          409
        )
      }
      await tx.deleteFrom("env_vars").where("id", "=", envVar.id).execute()
    }

    await tx
      .insertInto("secrets")
      .values({ id, app_id: appId, key, encrypted_value: encryptedValue, created_at: now, updated_at: now })
      .onConflict((oc) =>
        oc.columns(["app_id", "key"]).doUpdateSet({ encrypted_value: encryptedValue, updated_at: now })
      )
      .execute()

    const row = await tx
      .selectFrom("secrets")
      .selectAll()
      .where("app_id", "=", appId)
      .where("key", "=", key)
      .executeTakeFirstOrThrow()
    return mapSecret(row)
  })
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
