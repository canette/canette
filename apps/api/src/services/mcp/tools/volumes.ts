import { db } from "../../../db/db"
import { getProjectByRef } from "../../projects"
import { getAppById } from "../../apps"
import { listVolumes, createVolume, updateVolume, deleteVolume } from "../../volumes"
import { arg } from "../args"
import { REDEPLOY_NOTE } from "../notes"
import { appUiUrl, defineTool, err, notFound, ok, type ToolResult } from "../tool"
import type { VolumeConfig, VolumeType } from "@canette/types"

// Which volume type to pick is the part an agent can't infer from the schema.
const VOLUME_TYPES_NOTE =
  "Types: 'pvc' is a persistent disk that survives restarts and redeploys (databases, SQLite files, uploads); it requires size, locks the app to 1 replica, makes every deploy stop the old pod before starting the new one (brief downtime), and cannot be resized or changed later. 'emptyDir' is scratch space that is wiped whenever the pod restarts; size is an optional limit. 'configmap' mounts a single file with the given content at exactly mount_path (e.g. /etc/nginx/nginx.conf); the content is stored in plaintext and readable by the whole team, so never put secrets in it (use request_secret). Directory mounts over system paths (/etc, /usr, /var, ...) are rejected: use a path like /data."

export const volumeTools = [
  defineTool({
    name: "list_volumes",
    description:
      "List an app's mounted volumes: ID, name, type (pvc, emptyDir or configmap), mount path and config (size, or the file content for a configmap).",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      return ok(await listVolumes(db, appId))
    },
  }),
  defineTool({
    name: "create_volume",
    description: `Mount a volume into an app's container. ${VOLUME_TYPES_NOTE} ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        type: { type: "string", enum: ["pvc", "emptyDir", "configmap"], description: "Volume type" },
        mount_path: { type: "string", description: "Absolute path in the container: a directory for pvc and emptyDir, the file itself for configmap" },
        size: { type: "string", description: "Kubernetes quantity, e.g. '5Gi' or '500Mi': required for pvc, an optional limit for emptyDir" },
        content: { type: "string", description: "File content (max 1 MiB) — required for configmap" },
      },
      required: ["app_id", "type", "mount_path"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      const type = arg(args, "type")
      const mountPath = arg(args, "mount_path")
      if (!appId) return err("app_id is required")
      if (!type) return err("type is required")
      if (!mountPath) return err("mount_path is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const volume = await createVolume(db, appId, userId, {
        type: type as VolumeType,
        mountPath,
        config: { size: arg(args, "size"), content: arg(args, "content") },
      })
      return ok({ ...volume, note: REDEPLOY_NOTE })
    },
  }),
  defineTool({
    name: "update_volume",
    description: `Change a volume's config: the file content of a configmap, or the size limit of an emptyDir. A pvc cannot be changed after creation. The type and mount path can't be changed: delete the volume and create a new one instead. ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        volume_id: { type: "string", description: "Volume ID (from list_volumes)" },
        size: { type: ["string", "null"], description: "emptyDir only: new size limit, e.g. '1Gi'. Pass null or an empty string to remove the limit" },
        content: { type: "string", description: "configmap only: the new file content, replacing the old one (max 1 MiB)" },
      },
      required: ["app_id", "volume_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      const volumeId = arg(args, "volume_id")
      if (!appId) return err("app_id is required")
      if (!volumeId) return err("volume_id is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      if (!(await listVolumes(db, appId)).some((v) => v.id === volumeId)) return notFound("Volume not found on this app")
      // The service only touches size when the key is present; null clears it.
      const config: VolumeConfig = {}
      if ("size" in args) config.size = arg(args, "size") ?? ""
      if ("content" in args) config.content = arg(args, "content")
      const volume = await updateVolume(db, appId, volumeId, userId, { config })
      return ok({ ...volume, note: REDEPLOY_NOTE })
    },
  }),
  defineTool({
    name: "delete_volume",
    description: `Remove an emptyDir or configmap volume from an app. Persistent volumes (pvc) cannot be deleted with this tool, because that permanently deletes their data: for a pvc it returns a link to the app's settings, where the user can delete it themselves. Give the user that link and don't look for another way to delete it. ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        volume_id: { type: "string", description: "Volume ID (from list_volumes)" },
      },
      required: ["app_id", "volume_id"],
    },
    handler: deleteVolumeTool,
  }),
]

// Deleting a PVC deletes its data for good, so that is left to the user in the
// UI. emptyDir and configmap volumes hold nothing that isn't recreated.
async function deleteVolumeTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  const volumeId = arg(args, "volume_id")
  if (!appId) return err("app_id is required")
  if (!volumeId) return err("volume_id is required")
  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")
  const volume = (await listVolumes(db, appId)).find((v) => v.id === volumeId)
  if (!volume) return notFound("Volume not found on this app")

  if (volume.type === "pvc") {
    const project = await getProjectByRef(db, app.projectId, userId)
    if (!project) return notFound("App not found or access denied")
    const url = appUiUrl(project.slug, app.slug, "settings#volumes")
    return err(
      `'${volume.name}' (${volume.mountPath}) is a persistent volume, and deleting it permanently deletes its data. Persistent volumes can't be deleted through MCP. Give the user this link to delete it themselves in the app's settings: ${url}`,
      "USER_ACTION_REQUIRED"
    )
  }

  await deleteVolume(db, appId, volumeId, userId)
  return ok({ deleted: volume.name, note: REDEPLOY_NOTE })
}
