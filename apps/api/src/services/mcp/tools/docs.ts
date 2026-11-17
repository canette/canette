import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { docs as defaultDocs, renderDocsPage, DOCS_VERSION, type DocsIndex } from "../../../docs"
import { getSchema, schemaFileFor, SCHEMA_TARGETS, type SchemaFile } from "../../../docs/schemas"
import { parseTemplate } from "../../templates"
import { arg, argNum } from "../args"
import { defineTool, err, ok, type ToolResult } from "../tool"

// Public, read-only — no DB or access checks.

const DOCS_NOT_BUNDLED = "Docs are not bundled in this build of the canette API."
const DOCS_URI_PREFIX = "canette-docs://"
const SCHEMA_URI_PREFIX = "canette-schema://"
const MAX_DOCS_RESULTS = 20

export const docsTools = [
  defineTool({
    name: "search_docs",
    description:
      "Search the canette documentation (bundled with this instance, so it matches its version). Returns the best-matching sections with their page path; read a full page with get_docs_page.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. \"healthcheck\" or \"persistent volume\"" },
        limit: { type: "number", description: `Max results (default 5, max ${MAX_DOCS_RESULTS})` },
      },
      required: ["query"],
    },
    handler: (args) => searchDocsTool(args),
  }),
  defineTool({
    name: "get_docs_page",
    description:
      "Get one page of the canette documentation as markdown (bundled with this instance, so it matches its version). Key pages: configuration/canette-yaml (canette.yaml / canette_config reference), configuration/templates (canette-template.yaml), configuration/volumes, configuration/secrets, ai-agents/mcp. Use search_docs to find others.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Page path, e.g. \"configuration/canette-yaml\"" },
      },
      required: ["path"],
    },
    handler: (args) => getDocsPageTool(args),
  }),
  defineTool({
    name: "get_canette_yaml_schema",
    description:
      "Get the JSON Schema for canette.yaml (also the format of canette_config) or canette-template.yaml, bundled with this instance so it matches its version. Lists every field with its type, allowed values, defaults and a description. Unknown fields are allowed by canette but ignored.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["canette.yaml", "canette-template.yaml"],
          description: "Which file format to describe (default canette.yaml)",
        },
      },
    },
    handler: (args) => getSchemaTool(args),
  }),
  defineTool({
    name: "parse_template",
    description:
      "Validate a canette-template.yaml with canette's own template parser and return the parsed apps, exactly as the 'New app from template' wizard in the UI sees them. Writes nothing and creates or deploys nothing. Fields canette doesn't store on the app are returned per app as canetteConfig YAML. To set the apps up, call create_app for each one (pass its fields as snake_case arguments, e.g. gitUrl as git_url and canetteConfig as canette_config), then set_env_var for each entry in env, and request_secret with the names in secrets — never ask the user for secret values in the conversation. Check a gitCredentialId against list_git_credentials first. Volumes are not part of templates: add them with create_volume before the first trigger_deployment.",
    inputSchema: {
      type: "object",
      properties: {
        yaml: { type: "string", description: "The canette-template.yaml document (max 50 KB)" },
      },
      required: ["yaml"],
    },
    handler: async (args) => {
      const yaml = args.yaml
      // An empty document goes to the parser, which rejects it like the REST route does.
      if (typeof yaml !== "string") return err("yaml is required: the canette-template.yaml document as a string")
      return ok(await parseTemplate({ yaml }))
    },
  }),
]

export function searchDocsTool(args: Record<string, unknown>, index: DocsIndex = defaultDocs): ToolResult {
  if (index.isEmpty) return err(DOCS_NOT_BUNDLED, "UNAVAILABLE")
  const query = arg(args, "query")
  if (!query) return err("query is required")
  const limit = Math.min(Math.max(Math.trunc(argNum(args, "limit") ?? 5), 1), MAX_DOCS_RESULTS)
  const results = index.search(query, limit)
  return ok({ version: DOCS_VERSION, results })
}

export function getDocsPageTool(args: Record<string, unknown>, index: DocsIndex = defaultDocs): ToolResult {
  if (index.isEmpty) return err(DOCS_NOT_BUNDLED, "UNAVAILABLE")
  const path = arg(args, "path")
  if (!path) return err("path is required")
  const page = index.getPage(path)
  if (!page) {
    return err(`No docs page "${path}". Closest matches: ${index.suggest(path).join(", ")}. Use search_docs to find a page.`, "NOT_FOUND")
  }
  return { content: [{ type: "text", text: renderDocsPage(page) }] }
}

export function getSchemaTool(args: Record<string, unknown>): ToolResult {
  const target = arg(args, "file") ?? "canette.yaml"
  const file = schemaFileFor(target)
  if (!file) return err(`Unknown file "${target}". Use "canette.yaml" or "canette-template.yaml".`)
  return { content: [{ type: "text", text: getSchema(file) }] }
}

export function registerDocsResources(server: Server, index: DocsIndex = defaultDocs): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...(Object.entries(SCHEMA_TARGETS) as [SchemaFile, string][]).map(([file, yaml]) => ({
        uri: `${SCHEMA_URI_PREFIX}${file}`,
        name: file,
        title: `${yaml} JSON Schema`,
        description: `Every ${yaml} field with its type, allowed values and description`,
        mimeType: "application/schema+json",
      })),
      ...index.list().map((p) => ({
        uri: `${DOCS_URI_PREFIX}${p.path}`,
        name: p.path,
        title: p.title,
        description: p.description || undefined,
        mimeType: "text/markdown",
      })),
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    if (uri.startsWith(SCHEMA_URI_PREFIX)) {
      const file = schemaFileFor(uri.slice(SCHEMA_URI_PREFIX.length))
      if (!file) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
      return { contents: [{ uri, mimeType: "application/schema+json", text: getSchema(file) }] }
    }
    const page = uri.startsWith(DOCS_URI_PREFIX) ? index.getPage(uri) : undefined
    if (!page) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
    return { contents: [{ uri, mimeType: "text/markdown", text: renderDocsPage(page) }] }
  })
}
