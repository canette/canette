import { Hono } from "hono"
import { requireAuth } from "../middleware/require-auth"
import { parseTemplate } from "../services/templates"
import { ServiceError } from "../services/errors"
import type { AppEnv } from "../types"

export const templatesRouter = new Hono<AppEnv>()

templatesRouter.use("*", requireAuth)

// Parse a canette-template.yaml from inline YAML or a URL.
// POST /api/v1/templates/parse
templatesRouter.post("/templates/parse", async (c) => {
  const body = await c.req.json<{ yaml?: string; url?: string }>()
  try {
    const template = await parseTemplate(body)
    return c.json(template)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})
