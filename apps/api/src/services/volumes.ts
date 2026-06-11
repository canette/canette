import type { DB } from "../db/db"
import type { AppVolume, VolumeType, VolumeConfig } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { ServiceError } from "./errors"
import { getAppById } from "./apps"
import jsYaml from "js-yaml"

// ── Internal row type ─────────────────────────────────────────────────────────

type VolumeRow = Selectable<Database["app_volumes"]>

function mapVolume(row: VolumeRow): AppVolume {
  let config: VolumeConfig = {}
  try {
    config = JSON.parse(row.config) as VolumeConfig
  } catch {
    // default to empty config
  }
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    type: row.type as VolumeType,
    mountPath: row.mount_path,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateMountPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new ServiceError("Mount path must be an absolute path (starting with /)", "VALIDATION_ERROR", 400)
  }
  if (path.length > 253) {
    throw new ServiceError("Mount path must not exceed 253 characters", "VALIDATION_ERROR", 400)
  }
}

// k8sResourceName returns the K8s name for the given volume.
// PVC:       {appSlug}-{volumeName}
// ConfigMap: {appSlug}-{volumeName}-cfg
// emptyDir:  no resource (returns empty string)
function k8sResourceName(appSlug: string, volumeName: string, type: VolumeType): string {
  if (type === "pvc") return `${appSlug}-${volumeName}`
  if (type === "configmap") return `${appSlug}-${volumeName}-cfg`
  return ""
}

// generateVolumeName derives a valid K8s name from the mount path.
// The name is truncated so the longest K8s resource name fits in 63 chars.
// Example: /etc/nginx/nginx.conf → etc-nginx-nginx-conf
function generateVolumeName(mountPath: string, appSlug: string): string {
  // The longest suffix is "-cfg" (4 chars) for ConfigMap names: {appSlug}-{name}-cfg
  const maxLen = 63 - appSlug.length - 1 - 4 // leave room for appSlug + "-" + "-cfg"
  const sanitised = mountPath
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(1, maxLen))
    .replace(/-+$/, "")
  return sanitised || "volume"
}

// appNamespace replicates the Go AppNamespace logic: can-{id[:8]}-{slug[:50]}.
function appNamespace(projectId: string, projectSlug: string): string {
  return `can-${projectId.slice(0, 8)}-${projectSlug.slice(0, 50)}`
}

// getReplicasFromConfig parses the canette.yaml replicas field, defaulting to 1.
function getReplicasFromConfig(canetteConfig: string | null | undefined): number {
  if (!canetteConfig?.trim()) return 1
  try {
    const parsed = jsYaml.load(canetteConfig) as Record<string, unknown> | null
    if (parsed && typeof parsed === "object" && typeof parsed.replicas === "number") {
      return parsed.replicas
    }
  } catch {
    // parse error — treat as default
  }
  return 1
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function listVolumes(db: DB, appId: string): Promise<AppVolume[]> {
  const rows = await db
    .selectFrom("app_volumes")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "asc")
    .execute()
  return rows.map(mapVolume)
}

export async function createVolume(
  db: DB,
  appId: string,
  userId: string,
  input: {
    type: VolumeType
    mountPath: string
    config?: VolumeConfig
  }
): Promise<AppVolume> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  validateMountPath(input.mountPath)

  if (!["pvc", "emptyDir", "configmap"].includes(input.type)) {
    throw new ServiceError("type must be 'pvc', 'emptyDir', or 'configmap'", "VALIDATION_ERROR", 400)
  }

  const name = generateVolumeName(input.mountPath, app.slug)

  if (input.type === "pvc") {
    if (!input.config?.size?.trim()) {
      throw new ServiceError("size is required for PVC volumes (e.g. '5Gi')", "VALIDATION_ERROR", 400)
    }
    if (!/^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.test(input.config.size.trim())) {
      throw new ServiceError(
        "size must be a valid Kubernetes quantity (e.g. '5Gi', '500Mi')",
        "VALIDATION_ERROR",
        400
      )
    }
    const replicas = getReplicasFromConfig(app.canetteConfig)
    if (replicas > 1) {
      throw new ServiceError(
        "Cannot add a PVC volume to an app configured with replicas > 1. Set replicas to 1 in canette.yaml first.",
        "PVC_REPLICAS_CONFLICT",
        422
      )
    }
  }

  if (input.type === "configmap") {
    if (typeof input.config?.content !== "string" || input.config.content.length === 0) {
      throw new ServiceError("content is required for ConfigMap volumes", "VALIDATION_ERROR", 400)
    }
  }

  // Derive filename from mount path for configmap (stored for reference)
  const config: VolumeConfig = {}
  if (input.type === "pvc") {
    config.size = input.config!.size!.trim()
  } else if (input.type === "emptyDir" && input.config?.size?.trim()) {
    config.size = input.config.size.trim()
  } else if (input.type === "configmap") {
    config.content = input.config!.content
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    await db
      .insertInto("app_volumes")
      .values({
        id,
        app_id: appId,
        name,
        type: input.type,
        mount_path: input.mountPath,
        config: JSON.stringify(config),
        created_at: now,
        updated_at: now,
      })
      .execute()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ""
    if (msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("duplicate key")) {
      throw new ServiceError(
        `A volume mounted at '${input.mountPath}' already exists on this app`,
        "CONFLICT",
        409
      )
    }
    throw e
  }

  const row = await db
    .selectFrom("app_volumes")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
  return mapVolume(row)
}

export async function updateVolume(
  db: DB,
  appId: string,
  volumeId: string,
  userId: string,
  patch: { config?: VolumeConfig }
): Promise<AppVolume> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const row = await db
    .selectFrom("app_volumes")
    .selectAll()
    .where("id", "=", volumeId)
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!row) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const vol = mapVolume(row)

  // Only allow updating config fields that make sense per type.
  // PVC resize is not supported in v1 — the K8s PVC already exists.
  if (vol.type === "pvc") {
    throw new ServiceError("PVC volume configuration cannot be changed after creation", "VALIDATION_ERROR", 400)
  }

  const updatedConfig: VolumeConfig = { ...vol.config }

  if (vol.type === "configmap") {
    if (typeof patch.config?.content !== "string" || patch.config.content.length === 0) {
      throw new ServiceError("content is required for ConfigMap volumes", "VALIDATION_ERROR", 400)
    }
    updatedConfig.content = patch.config.content
  }

  if (vol.type === "emptyDir") {
    updatedConfig.size = patch.config?.size?.trim() || undefined
  }

  const now = new Date().toISOString()
  await db
    .updateTable("app_volumes")
    .set({ config: JSON.stringify(updatedConfig), updated_at: now })
    .where("id", "=", volumeId)
    .execute()

  const updated = await db
    .selectFrom("app_volumes")
    .selectAll()
    .where("id", "=", volumeId)
    .executeTakeFirstOrThrow()
  return mapVolume(updated)
}

export async function deleteVolume(
  db: DB,
  appId: string,
  volumeId: string,
  userId: string
): Promise<void> {
  const app = await getAppById(db, appId, userId)
  if (!app) throw new ServiceError("Not found", "NOT_FOUND", 404)

  const volRow = await db
    .selectFrom("app_volumes")
    .selectAll()
    .where("id", "=", volumeId)
    .where("app_id", "=", appId)
    .executeTakeFirst()
  if (!volRow) throw new ServiceError("Not found", "NOT_FOUND", 404)

  // Look up project ID and slug to compute the K8s namespace.
  const proj = await db
    .selectFrom("projects")
    .select(["id", "slug"])
    .where("id", "=",
      db.selectFrom("apps").select("project_id").where("id", "=", appId)
    )
    .executeTakeFirst()

  await db.deleteFrom("app_volumes").where("id", "=", volumeId).execute()

  const type = volRow.type as VolumeType
  if (type !== "emptyDir" && proj) {
    const ns = appNamespace(proj.id, proj.slug)
    const resourceName = k8sResourceName(app.slug, volRow.name, type)
    const resourceType = type === "pvc" ? "PersistentVolumeClaim" : "ConfigMap"
    const delId = crypto.randomUUID()
    const now = new Date().toISOString()
    await db
      .insertInto("pending_volume_deletions")
      .values({
        id: delId,
        namespace: ns,
        resource_type: resourceType,
        resource_name: resourceName,
        created_at: now,
      })
      .execute()
  }
}
