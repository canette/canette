import type { DB } from "../db/db"
import { sql } from "kysely"
import { supportsForUpdate } from "../db/dialect"

// An app's intent (app_intents, migration 000027) is what the user wants it to
// run: running or stopped, and the deployment it targets. Every lifecycle
// action (deploy, redeploy, stop, admin repair) changes it in the same
// transaction as its other writes, and bumps its generation, so the Go
// services can tell an outdated piece of work from the current one (#354).

export type DesiredState = "running" | "stopped"

// lockIntents locks the intent rows of the given apps for the rest of the
// transaction. A lifecycle transaction calls it before any other write, so
// every transaction that touches an app's lifecycle takes its locks in the
// same order. Rows are locked in app ID order, so two bulk callers can't
// deadlock either. An app without a row (one created before its row existed,
// e.g. by a test fixture) gets a default one first.
export async function lockIntents(tx: DB, appIds: string[]): Promise<void> {
  if (appIds.length === 0) return
  const ids = [...new Set(appIds)].sort()
  const now = new Date().toISOString()
  // Only for apps that still exist, so a concurrent delete leaves the caller
  // to report not found instead of failing on the foreign key.
  await tx
    .insertInto("app_intents")
    .columns(["app_id", "generation", "desired_state", "updated_at"])
    .expression((eb) =>
      eb.selectFrom("apps")
        .select((eb) => ["id", sql.lit(0).as("generation"), sql.lit("stopped").as("desired_state"), eb.val(now).as("updated_at")])
        .where("id", "in", ids)
    )
    .onConflict((oc) => oc.column("app_id").doNothing())
    .execute()
  if (!supportsForUpdate(tx)) return // SQLite (tests) has a single writer
  await tx
    .selectFrom("app_intents")
    .select("app_id")
    .where("app_id", "in", ids)
    .orderBy("app_id")
    .forUpdate()
    .execute()
}

export async function lockIntent(tx: DB, appId: string): Promise<void> {
  await lockIntents(tx, [appId])
}

// setIntent records a lifecycle action on an app whose intent row the
// transaction has locked (lockIntent). targetDeploymentId is left unchanged
// when omitted: Stop keeps the target, so it still names what to bring back.
export async function setIntent(
  tx: DB,
  appId: string,
  change: { desiredState: DesiredState; targetDeploymentId?: string; updatedBy: string | null },
): Promise<void> {
  await tx
    .updateTable("app_intents")
    .set({
      generation: sql<string>`generation + 1`,
      desired_state: change.desiredState,
      ...(change.targetDeploymentId !== undefined ? { target_deployment_id: change.targetDeploymentId } : {}),
      updated_at: new Date().toISOString(),
      updated_by: change.updatedBy,
    })
    .where("app_id", "=", appId)
    .execute()
}
