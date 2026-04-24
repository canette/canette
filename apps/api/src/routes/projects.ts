import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { ServiceError } from "../services/errors"
import {
  createProject,
  deleteProject,
  getProjectByRef,
  isProjectSlugAvailable,
  listProjects,
  updateProject,
} from "../services/projects"
import { listTeamCredentials } from "../services/git-credentials"

export const projectsRouter = new Hono<AppEnv>()

projectsRouter.use("*", requireAuth)

// Slug availability check
// GET /api/v1/projects/slug-available?slug=my-project
projectsRouter.get("/slug-available", async (c) => {
  const slug = c.req.query("slug") ?? ""
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(slug) || slug.endsWith("-")) {
    return c.json({ available: false, error: "Invalid slug format" })
  }
  const available = await isProjectSlugAvailable(db, slug)
  return c.json({ available })
})

// List projects the current user is a member of
// GET /api/v1/projects
projectsRouter.get("/", async (c) => {
  const session = c.get("session")
  const result = await listProjects(db, session.user.id)
  return c.json(result)
})

// Get a single project by UUID or slug
// GET /api/v1/projects/:ref
projectsRouter.get("/:ref", async (c) => {
  const session = c.get("session")
  const project = await getProjectByRef(db, c.req.param("ref"), session.user.id)
  if (!project) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(project)
})

// Create a project
// POST /api/v1/projects
projectsRouter.post("/", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ teamId: string; name: string; slug: string; description?: string }>()
  try {
    const project = await createProject(db, session.user.id, body)
    return c.json(project, 201)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Update a project
// PATCH /api/v1/projects/:id
projectsRouter.patch("/:id", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ name?: string; description?: string; slug?: string }>()
  try {
    const project = await updateProject(db, c.req.param("id"), session.user.id, body)
    return c.json(project)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Delete a project
// DELETE /api/v1/projects/:id
projectsRouter.delete("/:id", async (c) => {
  const session = c.get("session")
  try {
    await deleteProject(db, c.req.param("id"), session.user.id)
    return c.body(null, 204)
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status)
    throw e
  }
})

// Get a credentials for a project by UUID or slug
// TODO? Uses team. Saves UI roundtrip. Could be optimized with justom service method
// GET /api/v1/projects/:ref/credentials
projectsRouter.get("/:ref/credentials", async (c) => {
  const session = c.get("session")
  const project = await getProjectByRef(db, c.req.param("ref"), session.user.id)
  if (!project) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const credentials = await listTeamCredentials(db, project.teamId, session.user.id)
  if (!credentials) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  return c.json(credentials)
})
