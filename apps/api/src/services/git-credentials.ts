import type { Db } from "../db"
import type { GitCredential, GitProvider, GitCredentialType } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db-types"
import { encrypt } from "../crypto"
import { ServiceError } from "./errors"

// ── Internal row type ─────────────────────────────────────────────────────────

type GitCredentialRow = Selectable<Database["git_credentials"]>

function mapCredential(row: GitCredentialRow): GitCredential {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    provider: row.provider as GitProvider,
    type: row.type as GitCredentialType,
    createdAt: row.created_at,
    // encrypted_value intentionally omitted
  }
}

// ── System credential ─────────────────────────────────────────────────────────

// System credentials (e.g. cluster GitHub App) have user_id = NULL — they are
// owned by canette itself, visible to all users, and cannot be created, updated,
// or deleted through the user-facing API.
const GITHUB_APP_CREDENTIAL_ID = "github-app-cluster"

// initSystemCredentials upserts or removes the cluster GitHub App credential
// based on whether GITHUB_APP_ID is present in the environment.
// Call once at API startup.
export async function initSystemCredentials(db: Db): Promise<void> {
  if (process.env.GITHUB_APP_ID) {
    const now = new Date().toISOString()
    await db
      .insertInto("git_credentials")
      .values({
        id: GITHUB_APP_CREDENTIAL_ID,
        user_id: null,
        name: "GitHub App",
        provider: "github",
        type: "github_app",
        encrypted_value: encrypt(""),
        ssh_known_hosts: null,
        created_at: now,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute()
  } else {
    await db
      .deleteFrom("git_credentials")
      .where("id", "=", GITHUB_APP_CREDENTIAL_ID)
      .execute()
  }
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function listCredentials(
  db: Db,
  userId: string
): Promise<GitCredential[]> {
  const rows = await db
    .selectFrom("git_credentials")
    .selectAll()
    .where((eb) => eb.or([
      eb("user_id", "=", userId),
      eb("user_id", "is", null),
    ]))
    .orderBy("created_at", "desc")
    .execute()
  return rows.map(mapCredential)
}

export async function createCredential(
  db: Db,
  userId: string,
  input: {
    name: string
    provider: GitProvider
    type: GitCredentialType
    value?: string
    sshKnownHosts?: string
  }
): Promise<GitCredential> {
  if (!input.name?.trim()) throw new ServiceError("name is required", "VALIDATION_ERROR", 400)
  if (input.type === "github_app") throw new ServiceError("GitHub App credentials are managed automatically by canette", "NOT_ALLOWED", 422)
  if (!input.value?.trim()) throw new ServiceError("value is required", "VALIDATION_ERROR", 400)

  if (input.sshKnownHosts !== undefined && input.sshKnownHosts !== null) {
    if (Buffer.byteLength(input.sshKnownHosts, "utf8") > 10 * 1024) {
      throw new ServiceError("ssh_known_hosts exceeds 10 KB limit", "VALIDATION_ERROR", 400)
    }
    // Each non-empty, non-comment line must have at least two whitespace-separated
    // fields (hostname + key-type). This is the minimum for a valid known_hosts entry.
    const invalidLine = input.sshKnownHosts
      .split("\n")
      .find((line) => {
        const trimmed = line.trim()
        return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.split(/\s+/).length < 2
      })
    if (invalidLine !== undefined) {
      throw new ServiceError("ssh_known_hosts contains an invalid line", "VALIDATION_ERROR", 400)
    }
  }

  // Normalize SSH keys: strip CRLF line endings and ensure trailing newline.
  // libcrypto rejects keys with \r\n line endings, which browsers often produce on paste.
  const normalizedValue = input.type === "ssh_key"
    ? input.value!.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n"
    : input.value!

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const encryptedValue = encrypt(normalizedValue)

  try {
    await db
      .insertInto("git_credentials")
      .values({
        id,
        user_id: userId,
        name: input.name.trim(),
        provider: input.provider,
        type: input.type,
        encrypted_value: encryptedValue,
        ssh_known_hosts: input.sshKnownHosts ?? null,
        created_at: now,
      })
      .execute()
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new ServiceError("A credential with that name already exists", "CONFLICT", 409)
    }
    throw err
  }

  const row = await db
    .selectFrom("git_credentials")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapCredential(row)
}

export async function updateCredential(
  db: Db,
  userId: string,
  id: string,
  input: { value: string }
): Promise<GitCredential | null> {
  const existing = await db
    .selectFrom("git_credentials")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .executeTakeFirst()
  if (!existing) return null

  if (existing.type === "github_app") {
    throw new ServiceError("GitHub App credentials are managed by the canette admin and cannot be updated here", "NOT_UPDATABLE", 422)
  }

  if (!input.value?.trim()) throw new ServiceError("value is required", "VALIDATION_ERROR", 400)

  const normalizedValue = existing.type === "ssh_key"
    ? input.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n"
    : input.value

  const encryptedValue = encrypt(normalizedValue)

  await db
    .updateTable("git_credentials")
    .set({ encrypted_value: encryptedValue })
    .where("id", "=", id)
    .execute()

  const row = await db
    .selectFrom("git_credentials")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapCredential(row)
}

export async function deleteCredential(
  db: Db,
  userId: string,
  id: string
): Promise<boolean> {
  const existing = await db
    .selectFrom("git_credentials")
    .select(["id", "user_id"])
    .where("id", "=", id)
    .executeTakeFirst()
  if (!existing || existing.user_id == null || existing.user_id !== userId) return false

  await db
    .deleteFrom("git_credentials")
    .where("id", "=", id)
    .execute()
  return true
}
