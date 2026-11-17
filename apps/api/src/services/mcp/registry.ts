import type { McpTool } from "./tool"
import { projectTools } from "./tools/projects"
import { appTools } from "./tools/apps"
import { deploymentTools } from "./tools/deployments"
import { statusTools } from "./tools/status"
import { envTools } from "./tools/env"
import { volumeTools } from "./tools/volumes"
import { accessTools } from "./tools/access"
import { docsTools } from "./tools/docs"

// Every MCP tool, in the order tools/list returns them. A new tool goes in the
// tools/ module for its domain.
//
// When a tool here grants a new kind of access, update the permission list on
// the OAuth consent screen (apps/ui/src/app/oauth/authorize/consent-screen.tsx).
export const ALL_TOOLS: McpTool[] = [
  ...projectTools,
  ...appTools,
  ...deploymentTools,
  ...statusTools,
  ...envTools,
  ...volumeTools,
  ...accessTools,
  ...docsTools,
]

// The definitions advertised by tools/list, without the handlers.
export const TOOLS = ALL_TOOLS.map(({ handler: _handler, ...definition }) => definition)

export const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]))
