import type { Db } from "../db"

// getAppNamespace returns the Kubernetes namespace components needed to proxy log streams.
// Returns null if the user does not have access to the app.
// The namespace format must match AppNamespace() in apps/controller/internal/k8s/resources.go.
export async function getAppNamespace(
  db: Db,
  appId: string,
  userId: string
): Promise<{ appSlug: string; namespace: string } | null> {
  const row = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("memberships as m", "m.project_id", "p.id")
    .select([
      "a.slug as app_slug",
      "p.id as project_id",
      "p.slug as project_slug",
    ])
    .where("a.id", "=", appId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null

  const slug = row.project_slug.length > 50 ? row.project_slug.slice(0, 50) : row.project_slug
  return {
    appSlug: row.app_slug,
    namespace: `can-${row.project_id.slice(0, 8)}-${slug}`,
  }
}

// getScanSbom returns the CycloneDX SBOM for a deployment from scan_sboms.
// Returns null if the user does not have access or no SBOM exists.
export async function getScanSbom(
  db: Db,
  deploymentId: string,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("scan_sboms as s")
    .innerJoin("deployments as d", "d.id", "s.deployment_id")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select("s.content")
    .where("s.deployment_id", "=", deploymentId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return row.content
}

// getDeploymentManifest returns the stored YAML manifest for a deployment.
// Returns null if the user does not have access or the manifest hasn't been set.
export async function getDeploymentManifest(
  db: Db,
  deploymentId: string,
  userId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("deployments as d")
    .innerJoin("apps as a", "a.id", "d.app_id")
    .innerJoin("memberships as m", "m.project_id", "a.project_id")
    .select("d.applied_manifest")
    .where("d.id", "=", deploymentId)
    .where("m.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return row.applied_manifest
}
