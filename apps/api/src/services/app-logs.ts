import type { DB } from "../db/db"
import { freshKubernetesStatus } from "./apps"

// AppPodTarget identifies an app's pods for the logstreamer, which derives
// the Kubernetes namespace from projectId + projectSlug itself.
// servingDeploymentId is the deployment whose pods logs and metrics show by
// default (see servingDeployment).
export interface AppPodTarget {
  appSlug: string
  projectId: string
  projectSlug: string
  deploymentType: string
  servingDeploymentId: string | null
}

// getAppPodTarget returns what the logstreamer needs to locate an app's pods
// (log stream/tail, metrics). Returns null if the user does not have access
// to the app.
export async function getAppPodTarget(
  db: DB,
  appId: string,
  userId: string
): Promise<AppPodTarget | null> {
  const row = await db
    .selectFrom("apps as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("team_members as tm", "tm.team_id", "p.team_id")
    .leftJoin("app_runtime as r", "r.app_id", "a.id")
    .leftJoin("app_intents as i", "i.app_id", "a.id")
    .leftJoin("app_observed_status as o", "o.app_id", "a.id")
    .select([
      "a.slug as app_slug",
      "a.deployment_type",
      "p.id as project_id",
      "p.slug as project_slug",
      "r.applied_deployment_id",
      "i.desired_state",
      "o.kubernetes_status",
      "o.kubernetes_status_observed_at",
    ])
    .where("a.id", "=", appId)
    .where("tm.user_id", "=", userId)
    .executeTakeFirst()
  if (!row) return null

  const servingDeploymentId = servingDeployment(
    row.desired_state === "stopped" ? null : (row.applied_deployment_id ?? null),
    freshKubernetesStatus(row.kubernetes_status, row.kubernetes_status_observed_at)?.serving,
  )
  let deploymentType = row.deployment_type
  if (servingDeploymentId) {
    const dep = await db
      .selectFrom("deployments")
      .select("deployment_snapshot")
      .where("id", "=", servingDeploymentId)
      .where("app_id", "=", appId)
      .executeTakeFirst()
    deploymentType = snapshotDeploymentType(dep?.deployment_snapshot ?? null) ?? deploymentType
  }

  return {
    appSlug: row.app_slug,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    deploymentType,
    servingDeploymentId,
  }
}

// snapshotDeploymentType returns the workload type a deployment was rolled
// out as. The app's current deployment_type can differ until the next deploy
// (a web app edited to cronjob still runs a Deployment). Snapshots from
// before the field existed are web; null when the snapshot can't be read.
function snapshotDeploymentType(snapshot: string | null): string | null {
  if (!snapshot) return null
  try {
    const parsed = JSON.parse(snapshot) as { app?: { deployment_type?: string } }
    return parsed.app?.deployment_type || "web"
  } catch {
    return null
  }
}

// servingDeployment picks the deployment whose pods logs and metrics show by
// default (#332): the one the controller last rolled out (applied) while its
// pods are among the ready ones, else the one with the most ready pods, as
// last observed. With no fresh observation it is the applied one. During a
// rolling update the applied one serves next to the new one until the
// rollout succeeds, and after a failed rollout it is usually still the only
// one serving.
export function servingDeployment(
  applied: string | null,
  serving: { deploymentId: string }[] | undefined,
): string | null {
  if (!serving?.length || serving.some((s) => s.deploymentId === applied)) return applied
  return serving[0].deploymentId
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
