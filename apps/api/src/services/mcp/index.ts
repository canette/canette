import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { ServiceError } from "../errors"
import { SERVER_INSTRUCTIONS } from "./instructions"
import { TOOLS, TOOLS_BY_NAME } from "./registry"
import { err, type ToolResult } from "./tool"
import { registerDocsResources } from "./tools/docs"

export { ALL_TOOLS, TOOLS } from "./registry"
export { searchDocsTool, getDocsPageTool, getSchemaTool, registerDocsResources } from "./tools/docs"

export async function handleTool(name: string, args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return err(`Unknown tool: ${name}`, "UNKNOWN_TOOL")
  try {
    return await tool.handler(args, userId)
  } catch (e) {
    if (e instanceof ServiceError) return err(e.message, e.code)
    throw e
  }
}

export function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: "canette", version: process.env.APP_VERSION ?? "development" },
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  registerDocsResources(server)

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    return handleTool(name, (rawArgs ?? {}) as Record<string, unknown>, userId)
  })

  return server
}
