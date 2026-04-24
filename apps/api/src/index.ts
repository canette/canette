import { resolve } from "path"
import { initSystemCredentials } from "./services/git-credentials"
import { runMigrations } from "./db/migrations"
import { db } from "./db/db"
import { createApp } from "./app"

if (process.env.RUN_MIGRATIONS !== "false") {
  const migrationsDir = process.env.MIGRATIONS_DIR
    ?? resolve(process.cwd(), "migrations")
  await runMigrations(db, migrationsDir)
}

initSystemCredentials(db).catch((err) => {
  console.error("failed to init system credentials:", err)
})

const app = createApp(db)

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
}
