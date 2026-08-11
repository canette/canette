import type { DB } from "../db/db"
import type { AppVolume, VolumeType, VolumeConfig } from "@canette/types"
import type { Selectable } from "kysely"
import type { Database } from "../db/types"
import { ServiceError } from "./errors"
import { getAppById } from "./apps"
import { getReplicasFromCanetteConfig } from "./canette-config"
import { supportsForUpdate } from "../db/dialect"

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

// System directories that must never have a *directory* mounted over them —
// doing so shadows the runtime in ways that produce confusing errors.
// ConfigMaps use subPath and mount a single file, so they can safely live
// inside /etc, /usr/local, etc. — only the directories themselves are blocked.
const RESERVED_DIRECTORIES = new Set([
  "/", "/etc", "/proc", "/sys", "/dev", "/usr", "/var", "/bin", "/sbin",
  "/lib", "/lib64", "/boot", "/run", "/root", "/home",
])
// Path prefixes whose entire subtree is off-limits, even for single-file mounts.
const RESERVED_PREFIXES = ["/proc", "/sys", "/dev"]

function validateMountPath(p: string, type: VolumeType): void {
  if (!p.startsWith("/")) {
    throw new ServiceError("Mount path must be an absolute path (starting with /)", "VALIDATION_ERROR", 400)
  }
  if (p.length > 253) {
    throw new ServiceError("Mount path must not exceed 253 characters", "VALIDATION_ERROR", 400)
  }
  if (p.includes("..") || p.includes("//")) {
    throw new ServiceError("Mount path must not contain '..' or '//'", "VALIDATION_ERROR", 400)
  }
  // Normalise trailing slash ("/etc/" → "/etc") for comparison.
  const normalised = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p

  if (RESERVED_DIRECTORIES.has(normalised)) {
    throw new ServiceError(
      `Mount path '${p}' is a system directory. Choose a sub-path or a directory under /data, /app, or similar.`,
      "VALIDATION_ERROR",
      400
    )
  }
  for (const reserved of RESERVED_PREFIXES) {
    if (normalised === reserved || normalised.startsWith(reserved + "/")) {
      throw new ServiceError(
        `Mount path '${p}' is inside a virtual filesystem (${reserved}) and cannot be mounted.`,
        "VALIDATION_ERROR",
        400
      )
    }
  }
  // Directory mounts (PVC/emptyDir) shadow the entire target — block them
  // anywhere under typical system trees. ConfigMaps mount one file via subPath
  // and are safe at e.g. /etc/nginx/nginx.conf.
  if (type !== "configmap") {
    for (const reserved of ["/etc", "/usr", "/var", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/run", "/root"]) {
      if (normalised.startsWith(reserved + "/")) {
        throw new ServiceError(
          `Directory mounts under ${reserved} are not allowed (they shadow the system tree). Use a ConfigMap to mount a single file, or pick a path under /data, /app, or /workspace.`,
          "VALIDATION_ERROR",
          400
        )
      }
    }
  }
}

// Matches Kubernetes resource.Quantity:
//   decimal SI (k, M, G, T, P, E)   — k is intentionally lowercase
//   binary (Ki, Mi, Gi, Ti, Pi, Ei)
// Source: k8s.io/apimachinery resource.ParseQuantity.
const K8S_QUANTITY_RE = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/

function validateQuantity(label: string, raw: string): void {
  if (!K8S_QUANTITY_RE.test(raw)) {
    throw new ServiceError(
      `${label} must be a valid Kubernetes quantity (e.g. '5Gi', '500Mi')`,
      "VALIDATION_ERROR",
      400
    )
  }
}

// K8s ConfigMap data is capped at 1 MiB per object.
const CONFIGMAP_MAX_BYTES = 1024 * 1024

function validateConfigMapContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.length === 0) {
    throw new ServiceError("content is required for ConfigMap volumes", "VALIDATION_ERROR", 400)
  }
  // UTF-8 byte length, not character count — matches what K8s stores.
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > CONFIGMAP_MAX_BYTES) {
    throw new ServiceError(
      `content exceeds the 1 MiB ConfigMap limit (got ${bytes} bytes)`,
      "VALIDATION_ERROR",
      400
    )
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

// generateVolumeName derives a valid K8s name from the mount path. Returns null
// when no truncation can produce a name that fits within the K8s 63-char DNS-1123
// limit for the longest derived resource name (ConfigMap: {appSlug}-{name}-cfg).
function generateVolumeName(mountPath: string, appSlug: string): string | null {
  // "-cfg" (4) is the longest suffix; reserve appSlug + "-" + "-cfg" = appSlug.length + 5.
  const maxLen = 63 - appSlug.length - 5
  if (maxLen < 1) return null
  const sanitised = mountPath
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "")
  return sanitised || "volume"
}

// appNamespace replicates the Go libk8s.AppNamespace logic: can-{id[:8]}-{slug[:50]}.
// MUST stay in sync with apps/lib/k8s/AppNamespace — if you change the format here,
// change it there too.
function appNamespace(projectId: string, projectSlug: string): string {
  return `can-${projectId.slice(0, 8)}-${projectSlug.slice(0, 50)}`
}

function isUniqueConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : ""
  return msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("duplicate key")
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

  if (!["pvc", "emptyDir", "configmap"].includes(input.type)) {
    throw new ServiceError("type must be 'pvc', 'emptyDir', or 'configmap'", "VALIDATION_ERROR", 400)
  }

  validateMountPath(input.mountPath, input.type)

  const name = generateVolumeName(input.mountPath, app.slug)
  if (name === null) {
    throw new ServiceError(
      "App slug is too long to derive a volume name that fits Kubernetes' 63-character limit. Use a shorter app slug.",
      "VALIDATION_ERROR",
      400
    )
  }

  // Build the persisted config per-type, validating size/content as we go.
  const config: VolumeConfig = {}
  if (input.type === "pvc") {
    if (!input.config?.size?.trim()) {
      throw new ServiceError("size is required for PVC volumes (e.g. '5Gi')", "VALIDATION_ERROR", 400)
    }
    validateQuantity("size", input.config.size.trim())
    config.size = input.config.size.trim()
  } else if (input.type === "emptyDir") {
    if (input.config?.size?.trim()) {
      validateQuantity("size", input.config.size.trim())
      config.size = input.config.size.trim()
    }
  } else if (input.type === "configmap") {
    validateConfigMapContent(input.config?.content)
    config.content = input.config!.content!
  }

  // PVC + replicas guard, plus the insert, run in a single transaction with
  // SELECT ... FOR UPDATE on the apps row to prevent TOCTOU with concurrent
  // app updates that change canette_config or add other PVC volumes.
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  try {
    return await db.transaction().execute(async (tx) => {
      if (input.type === "pvc") {
        let q = tx
          .selectFrom("apps")
          .select(["canette_config"])
          .where("id", "=", appId)
        if (supportsForUpdate(tx)) q = q.forUpdate()
        const lockedApp = await q.executeTakeFirstOrThrow()
        const replicas = getReplicasFromCanetteConfig(lockedApp.canette_config)
        if (replicas > 1) {
          throw new ServiceError(
            "Cannot add a PVC volume to an app configured with replicas > 1. Set replicas to 1 in canette.yaml first.",
            "PVC_REPLICAS_CONFLICT",
            422
          )
        }
      }

      try {
        await tx
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
        if (isUniqueConstraintError(e)) {
          // The DB has two unique constraints: (app_id, name) and (app_id, mount_path).
          // We don't know which fired from the message alone — query to disambiguate.
          const existing = await tx
            .selectFrom("app_volumes")
            .select(["mount_path", "name"])
            .where("app_id", "=", appId)
            .where((eb) => eb.or([eb("mount_path", "=", input.mountPath), eb("name", "=", name)]))
            .executeTakeFirst()
          if (existing?.mount_path === input.mountPath) {
            throw new ServiceError(
              `A volume mounted at '${input.mountPath}' already exists on this app`,
              "CONFLICT",
              409
            )
          }
          throw new ServiceError(
            `Mount path '${input.mountPath}' derives the same volume name ('${name}') as an existing volume — choose a more distinct path`,
            "CONFLICT",
            409
          )
        }
        throw e
      }

      const row = await tx
        .selectFrom("app_volumes")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
      return mapVolume(row)
    })
  } catch (e) {
    if (e instanceof ServiceError) throw e
    throw e
  }
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

  // PVC resize is not supported in v1 — the K8s PVC already exists.
  if (vol.type === "pvc") {
    throw new ServiceError("PVC volume configuration cannot be changed after creation", "VALIDATION_ERROR", 400)
  }

  const updatedConfig: VolumeConfig = { ...vol.config }

  if (vol.type === "configmap") {
    validateConfigMapContent(patch.config?.content)
    updatedConfig.content = patch.config!.content!
  }

  if (vol.type === "emptyDir") {
    // Only touch size when explicitly provided. `null` or empty string clears it.
    if (patch.config && "size" in patch.config) {
      const trimmed = patch.config.size?.trim() ?? ""
      if (trimmed === "") {
        updatedConfig.size = undefined
      } else {
        validateQuantity("size", trimmed)
        updatedConfig.size = trimmed
      }
    }
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

  // Pull the project slug now so we can compute the namespace inside the tx.
  const project = await db
    .selectFrom("projects")
    .select(["id", "slug"])
    .where("id", "=", app.projectId)
    .executeTakeFirst()

  await db.transaction().execute(async (tx) => {
    const volRow = await tx
      .selectFrom("app_volumes")
      .selectAll()
      .where("id", "=", volumeId)
      .where("app_id", "=", appId)
      .executeTakeFirst()
    if (!volRow) throw new ServiceError("Not found", "NOT_FOUND", 404)

    const type = volRow.type as VolumeType
    if (type !== "emptyDir") {
      if (!project) {
        // Should be impossible — we already loaded `app`, which requires a project row.
        throw new ServiceError("App project not found", "NOT_FOUND", 404)
      }
      const ns = appNamespace(project.id, project.slug)
      const resourceName = k8sResourceName(app.slug, volRow.name, type)
      const resourceType = type === "pvc" ? "PersistentVolumeClaim" : "ConfigMap"
      await tx
        .insertInto("pending_volume_deletions")
        .values({
          id: crypto.randomUUID(),
          namespace: ns,
          resource_type: resourceType,
          resource_name: resourceName,
          created_at: new Date().toISOString(),
        })
        .execute()
    }

    await tx.deleteFrom("app_volumes").where("id", "=", volumeId).execute()
  })
}
