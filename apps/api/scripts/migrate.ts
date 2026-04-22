import { Client } from "pg"
import { readdir, readFile } from "fs/promises"
import { join, resolve } from "path"

export async function runMigrations(): Promise<void> {
  const migrationsDir = process.env.MIGRATIONS_DIR
    ?? resolve(import.meta.dir, "../migrations")

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required")
  }

  const client = new Client({ connectionString: dbUrl })
  await client.connect()

  // Ensure migrations tracking table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)

  const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations")
  const applied = new Set(rows.map((r) => r.version))

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".up.sql"))
    .sort()

  let count = 0
  for (const file of files) {
    const version = file.replace(".up.sql", "")
    if (applied.has(version)) {
      console.log(`  skip  ${version}`)
      continue
    }

    const sql = await readFile(join(migrationsDir, file), "utf8")
    await client.query(sql)
    await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
      version,
      new Date().toISOString(),
    ])
    console.log(`  apply ${version}`)
    count++
  }

  console.log(`\nDone — ${count} migration(s) applied`)
  await client.end()
}

if (import.meta.main) {
  await runMigrations()
}
