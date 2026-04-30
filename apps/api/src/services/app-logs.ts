import type { DB } from "../db/db"
import { appNamespace } from "../utils/k8s"

// getAppNamespace returns the Kubernetes namespace components needed to proxy log streams.
// Returns null if the user does not have access to the app.
export async function getAppNamespace(
  db: DB,
  appId: string,
  userId: string
): Promise<{ appSlug: string; namespace: string } | null> {
  const row = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select([
      "a.slug as app_slug",
      "p.id as project_id",
      "p.slug as project_slug",
    ])
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null

  return {
    appSlug: row.app_slug,
    namespace: appNamespace(row.project_id, row.project_slug),
  }
}

// getScanSbom returns the CycloneDX SBOM for a deployment from scan_sboms.
// Returns null if the user does not have access or no SBOM exists.
export async function getScanSbom(
  db: DB,
  deploymentId: string,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("scan_sboms as s")
    .innerJoin("deployments as d", "d.id", "s.deployment_id")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select("s.content")
    .where("s.deployment_id", "=", deploymentId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return row.content
}

// getDeploymentManifest returns the stored YAML manifest for a deployment.
// Returns null if the user does not have access or the manifest hasn't been set.
export async function getDeploymentManifest(
  db: DB,
  deploymentId: string,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .select("d.applied_manifest")
    .where("d.id", "=", deploymentId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return row.applied_manifest
}
