import jsyaml from "js-yaml"
import { ServiceError } from "./errors"
import type { AppTemplate, AppSourceType, TemplateApp } from "@canette/types"

const MAX_TEMPLATE_SIZE = 50 * 1024

// Fields consumed directly into the App row or as separate API calls.
// Everything else is serialised back to YAML and stored as canetteConfig.
const APP_ROW_FIELDS = new Set([
  "name", "slug", "source_type", "git_url", "git_branch",
  "git_credential_id", "app_path", "image_url", "image_tag",
  "port", "env", "secrets",
])

function parseTemplateApp(raw: Record<string, unknown>, index: number): TemplateApp {
  const name = raw.name
  const slug = raw.slug

  if (typeof name !== "string" || !name.trim()) {
    throw new ServiceError(`App ${index + 1}: 'name' is required`, "INVALID_TEMPLATE", 400)
  }
  if (typeof slug !== "string" || !slug.trim()) {
    throw new ServiceError(`App '${name}': 'slug' is required`, "INVALID_TEMPLATE", 400)
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug.endsWith("-")) {
    throw new ServiceError(
      `App '${name}': slug '${slug}' is invalid — use lowercase alphanumeric and hyphens`,
      "INVALID_TEMPLATE",
      400,
    )
  }

  const sourceType = raw.source_type
  if (sourceType !== undefined && sourceType !== "git" && sourceType !== "image") {
    throw new ServiceError(`App '${name}': source_type must be 'git' or 'image'`, "INVALID_TEMPLATE", 400)
  }

  const env = raw.env
  if (env !== undefined && (typeof env !== "object" || Array.isArray(env) || env === null)) {
    throw new ServiceError(`App '${name}': env must be a key-value map`, "INVALID_TEMPLATE", 400)
  }

  const secrets = raw.secrets
  if (secrets !== undefined) {
    if (!Array.isArray(secrets)) {
      throw new ServiceError(`App '${name}': secrets must be an array`, "INVALID_TEMPLATE", 400)
    }
    for (const s of secrets) {
      if (typeof s !== "string" && (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>).name !== "string")) {
        throw new ServiceError(
          `App '${name}': each secret must be a string or an object with a 'name' field`,
          "INVALID_TEMPLATE",
          400,
        )
      }
    }
  }

  // Any unrecognised fields → serialised as canetteConfig YAML
  const canetteFields: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (!APP_ROW_FIELDS.has(key)) canetteFields[key] = val
  }
  const canetteConfig =
    Object.keys(canetteFields).length > 0 ? jsyaml.dump(canetteFields) : undefined

  return {
    name: (name as string).trim(),
    slug: (slug as string).trim(),
    sourceType: ((sourceType as string | undefined) ?? "git") as AppSourceType,
    gitUrl: typeof raw.git_url === "string" ? raw.git_url : undefined,
    gitBranch: typeof raw.git_branch === "string" ? raw.git_branch : undefined,
    gitCredentialId: typeof raw.git_credential_id === "string" ? raw.git_credential_id : undefined,
    appPath: typeof raw.app_path === "string" ? raw.app_path : undefined,
    imageUrl: typeof raw.image_url === "string" ? raw.image_url : undefined,
    imageTag: typeof raw.image_tag === "string" ? raw.image_tag : undefined,
    port: typeof raw.port === "number" ? raw.port : undefined,
    env: env as Record<string, string> | undefined,
    secrets: secrets
      ? (secrets as Array<string | { name: string; description?: string }>).map((s) =>
          typeof s === "string" ? { name: s } : { name: s.name, description: s.description },
        )
      : undefined,
    canetteConfig,
  }
}

export async function parseTemplate(input: { yaml: string }): Promise<AppTemplate> {
  if (input.yaml.length > MAX_TEMPLATE_SIZE) {
    throw new ServiceError("Template exceeds the 50 KB limit", "TOO_LARGE", 400)
  }
  const yamlContent = input.yaml

  let doc: unknown
  try {
    doc = jsyaml.load(yamlContent)
  } catch {
    throw new ServiceError("Invalid YAML: could not parse template", "INVALID_YAML", 400)
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ServiceError("Template must be a YAML object at the top level", "INVALID_TEMPLATE", 400)
  }

  const root = doc as Record<string, unknown>

  if (typeof root.name !== "string" || !root.name.trim()) {
    throw new ServiceError("Template 'name' is required", "INVALID_TEMPLATE", 400)
  }

  if (!Array.isArray(root.apps) || root.apps.length === 0) {
    throw new ServiceError("Template must have an 'apps' array with at least one entry", "INVALID_TEMPLATE", 400)
  }

  const apps = root.apps.map((app, i) => {
    if (typeof app !== "object" || app === null || Array.isArray(app)) {
      throw new ServiceError(`App ${i + 1}: must be a YAML object`, "INVALID_TEMPLATE", 400)
    }
    return parseTemplateApp(app as Record<string, unknown>, i)
  })

  const slugsSeen = new Set<string>()
  for (const app of apps) {
    if (slugsSeen.has(app.slug)) {
      throw new ServiceError(`Duplicate slug '${app.slug}' in template`, "INVALID_TEMPLATE", 400)
    }
    slugsSeen.add(app.slug)
  }

  return {
    name: root.name.trim(),
    description: typeof root.description === "string" ? root.description.trim() : undefined,
    apps,
  }
}
