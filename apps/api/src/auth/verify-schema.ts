import { auth } from "./auth"

/**
 * Runs better-auth's schema check against the live database and exits the
 * process if any table or column it needs (`user`, `session`, `account`,
 * `verification`, plus every field a configured plugin adds) is missing.
 *
 * Must be called after migrations have run. A failure to reach the database is
 * logged but not fatal: better-auth does not cache those, so the check is
 * retried on the next auth request.
 */
export async function verifyAuthSchema(): Promise<void> {
  const ctx = await auth.$context
  try {
    await ctx.checkSchema?.()
  } catch (err) {
    if ((err as { code?: string }).code === "SCHEMA_MISMATCH") {
      console.error(
        "better-auth schema does not match the migrated database, refusing to start.\n"
        + "Add the missing tables/columns to a new migration in apps/api/migrations/.\n",
        (err as Error).message,
      )
      process.exit(1)
    }
    console.error("could not validate the better-auth schema:", err)
  }
}
