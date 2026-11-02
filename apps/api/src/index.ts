import { resolve } from "path"
import { runMigrations } from "./db/migrations"
import { db } from "./db/db"

// Ordering matters here. better-auth validates the database schema as soon as
// `betterAuth()` is constructed and caches a failed result for the life of the
// process. If `auth.ts` were loaded before migrations ran, a fresh database
// would be seen with no tables and every auth request would fail with
// "Missing tables: user, session, account, verification" until a restart.
// So: only db + migrations are imported statically; everything that can reach
// `./auth/auth` is imported dynamically after migrations complete.
// tests/startup-order.test.ts enforces this.

if (process.env.RUN_MIGRATIONS !== "false") {
  const migrationsDir = process.env.MIGRATIONS_DIR
    ?? resolve(process.cwd(), "migrations")
  try {
    await runMigrations(db, migrationsDir)
  } catch (err) {
    console.error("Migration failed, refusing to start:", err)
    process.exit(1)
  }
}

const { createApp } = await import("./app")
const { verifyAuthSchema } = await import("./auth/verify-schema")
const { initSystemCredentials } = await import("./services/git-credentials")

// Fail fast if the migrated schema does not match what better-auth expects
// (e.g. a plugin field that was never mirrored into a migration), rather than
// starting up and returning 500 on the first sign-up/sign-in.
await verifyAuthSchema()

initSystemCredentials(db).catch((err) => {
  console.error("failed to init system credentials:", err)
})

const app = createApp()

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
}
