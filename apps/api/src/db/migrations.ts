import { sql } from 'kysely'
import { readdir, readFile } from "fs/promises"
import { join } from "path"
import { DB } from "./db"

export async function runMigrations(db: DB, migrationsDir: string): Promise<void> {

  // Ensure migrations tracking table exists
  await db.schema.createTable("schema_migrations")
    .ifNotExists()
    .addColumn('version', 'text', (cb) => cb.primaryKey().notNull())
    .addColumn('applied_at', 'text', (cb) => cb.notNull()) // Change to timestamp
    .execute()

  const rows = await db.selectFrom("schema_migrations")
    .select("version")
    .execute()

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

    console.log(`  applying ${version}...`)
    const sqlFile = await readFile(join(migrationsDir, file), "utf8")
    const statements = sqlFile.split(";").map((s) => s.trim()).filter((s) => s.length > 0)
    for (const stmt of statements) {
      await sql.raw(stmt).execute(db)
    }

    await db.insertInto("schema_migrations")
      .values({
        version,
        applied_at: new Date().toISOString(),
      })
      .execute()

    count++
  }

  console.log(`\nDone — ${count} migration(s) applied`)  
}