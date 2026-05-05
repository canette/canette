import { Hono } from "hono"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { requireBearer, type McpEnv } from "../middleware/require-bearer"
import { buildMcpServer } from "../services/mcp"

export const mcpRouter = new Hono<McpEnv>()

mcpRouter.use("*", requireBearer)

mcpRouter.all("/", async (c) => {
  const userId = c.get("mcpUserId")
  const server = buildMcpServer(userId)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})
