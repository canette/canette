import { Hono } from "hono"
import { db } from "../db/db"
import { requireAuth } from "../middleware/require-auth"
import type { AppEnv } from "../types"
import { getCurrentUser, updateCurrentUser } from "../services/admin"
import { ServiceError } from "../services/errors"

export const usersRouter = new Hono<AppEnv>()

usersRouter.use("*", requireAuth)

// Get the current authenticated user
// GET /api/v1/users/me
usersRouter.get("/me", async (c) => {
  const session = c.get("session")
  const user = await getCurrentUser(db, session.user.id)
  if (!user) return c.json({ error: "User not found", code: "NOT_FOUND" }, 404)
  return c.json(user)
})

// Update the current user's name
// PATCH /api/v1/users/me
usersRouter.patch("/me", async (c) => {
  const session = c.get("session")
  const body = await c.req.json<{ name?: string }>()
  const name = body.name?.trim()
  if (!name) {
    return c.json({ error: "Name is required", code: "INVALID_INPUT" }, 400)
  }
  try {
    const user = await updateCurrentUser(db, session.user.id, { name })
    return c.json(user)
  } catch (err) {
    if (err instanceof ServiceError) {
      return c.json({ error: err.message, code: err.code }, err.status)
    }
    throw err
  }
})
