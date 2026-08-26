import type { DB } from "../db/db"
import type { AppPasswordGate } from "@canette/types"
import { password } from "bun"
import { ServiceError } from "./errors"
import { getAppById } from "./apps"
import { AUTHGATE_SIDECAR_PORT } from "./reserved-ports"

export { AUTHGATE_SIDECAR_PORT }

// bcrypt silently truncates input beyond 72 bytes — reject rather than let a
// user set a password that only its first 72 bytes actually protect against.
const BCRYPT_MAX_BYTES = 72

function validatePassword(password: string): void {
  if (!password) {
    throw new ServiceError("Password is required", "VALIDATION_ERROR", 400)
  }
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    throw new ServiceError(`Password must not exceed ${BCRYPT_MAX_BYTES} bytes`, "VALIDATION_ERROR", 400)
  }
}

// ── Service functions ─────────────────────────────────────────────────────────
// Callers must verify app access (via getAppById) before calling these — this
// module does the same team-scoped lookup itself since every entry point needs it.

export async function getPasswordGateStatus(db: DB, appId: string, userId: string): Promise<AppPasswordGate> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("apps")
    .select(["password_gate_enabled"])
    .where("id", "=", appId)
    .executeTakeFirstOrThrow()

  // SQLite has no native boolean type, so the test driver returns 0/1 here —
  // coerce rather than pass the raw column value through.
  return { enabled: !!row.password_gate_enabled }
}

export async function enablePasswordGate(
  db: DB,
  appId: string,
  userId: string,
  input: { password: string }
): Promise<AppPasswordGate> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  if (app.deploymentType !== "web") {
    throw new ServiceError("Password protection is only supported for web apps", "VALIDATION_ERROR", 422)
  }

  validatePassword(input.password)

  const passwordHash = await password.hash(input.password, { algorithm: "bcrypt", cost: 10 })
  const now = new Date().toISOString()

  await db
    .updateTable("apps")
    .set({
      password_gate_enabled: true,
      password_gate_password_hash: passwordHash,
      updated_at: now,
    })
    .where("id", "=", appId)
    .execute()

  return { enabled: true }
}

export async function disablePasswordGate(db: DB, appId: string, userId: string): Promise<AppPasswordGate> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const now = new Date().toISOString()
  await db
    .updateTable("apps")
    .set({
      password_gate_enabled: false,
      password_gate_password_hash: null,
      updated_at: now,
    })
    .where("id", "=", appId)
    .execute()

  return { enabled: false }
}
