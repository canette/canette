import { createHash, randomBytes } from "node:crypto"
import type { DB } from "../db/db"

// State for the GitHub App installation flow, stored server-side so that each
// value can be used exactly once. The value sent to GitHub is an opaque random
// id; the row behind it holds the team and user that started the flow.
//
// The flow has two steps, each with its own row:
//   install   — created by /install-url, consumed by the Setup URL callback
//   authorize — created by that callback with the installation_id GitHub
//               reported and a PKCE verifier, consumed by the OAuth callback
//               once the user's own token shows they can access the installation

const STATE_TTL_MS = 10 * 60 * 1000

export type InstallState = {
  teamId: string
  userId: string
  installationId: string | null
  codeVerifier: string | null
}

export async function createInstallState(
  db: DB,
  teamId: string,
  userId: string,
  authorize?: { installationId: string; codeVerifier: string },
): Promise<string> {
  const now = new Date()
  await db.deleteFrom("github_app_install_states").where("expires_at", "<", now.toISOString()).execute()

  const id = randomBytes(32).toString("base64url")
  await db.insertInto("github_app_install_states").values({
    id,
    team_id: teamId,
    user_id: userId,
    installation_id: authorize?.installationId ?? null,
    code_verifier: authorize?.codeVerifier ?? null,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
    created_at: now.toISOString(),
  }).execute()
  return id
}

// consumeInstallState deletes the state and returns it, or null if it is
// unknown, already used, expired, or belongs to the other step. The delete is
// what makes it single-use: of two concurrent callbacks with the same state,
// only one deletes the row.
export async function consumeInstallState(
  db: DB,
  id: string,
  step: "install" | "authorize",
): Promise<InstallState | null> {
  const row = await db.selectFrom("github_app_install_states").selectAll().where("id", "=", id).executeTakeFirst()
  if (!row) return null

  const deleted = await db.deleteFrom("github_app_install_states").where("id", "=", id).executeTakeFirst()
  if (Number(deleted.numDeletedRows) !== 1) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  if ((step === "authorize") !== (row.installation_id !== null)) return null

  return {
    teamId: row.team_id,
    userId: row.user_id,
    installationId: row.installation_id,
    codeVerifier: row.code_verifier,
  }
}

export function createCodeVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}
