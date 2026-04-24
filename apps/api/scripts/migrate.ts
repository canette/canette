import { resolve } from "path"
import { db } from "../src/db/db"
import { runMigrations } from "../src/db/migrations"

export async function mainMigrations(): Promise<void> {
  const migrationsDir = process.env.MIGRATIONS_DIR
    ?? resolve(process.cwd(), "migrations")

  await runMigrations(db, migrationsDir)
  await db.destroy()
}

if (import.meta.main) {
  await mainMigrations()
}
