export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

// One MCP tool: what tools/list advertises, plus the handler that runs it.
export type McpTool = {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
  handler: (args: Record<string, unknown>, userId: string) => Promise<ToolResult> | ToolResult
}

export function defineTool(tool: McpTool): McpTool {
  return tool
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

// Tool errors use the REST error shape, so a client can branch on the code
// instead of parsing the message. Codes are a ServiceError's own, or:
// VALIDATION_ERROR (bad arguments), NOT_FOUND (also when access is denied, so
// other teams' resources stay invisible), UNAVAILABLE (a backing service is
// down or not configured), USER_ACTION_REQUIRED (refused over MCP; the message
// has a link for the user) and UNKNOWN_TOOL.
export function err(message: string, code = "VALIDATION_ERROR"): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message, code }) }], isError: true }
}

export function notFound(message: string): ToolResult {
  return err(message, "NOT_FOUND")
}

// A link to one of the app's pages in the UI, e.g. "settings#volumes".
export function appUiUrl(projectSlug: string, appSlug: string, path: string): string {
  const uiUrl = (process.env.UI_URL ?? "http://localhost:3000").replace(/\/$/, "")
  return `${uiUrl}/dashboard/projects/${encodeURIComponent(projectSlug)}/apps/${encodeURIComponent(appSlug)}/${path}`
}
