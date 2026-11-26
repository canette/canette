import { sql } from 'kysely'
import { readdir, readFile } from "fs/promises"
import { join } from "path"
import { DB } from "./db"
import { isSqlite } from "./dialect"

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

  const allFiles = await readdir(migrationsDir)
  const files = allFiles.filter((f) => f.endsWith(".up.sql")).sort()
  // A migration that SQLite can't run as written (e.g. one that alters a
  // CHECK constraint) has a {version}.up.sqlite.sql next to it, which the
  // SQLite test database runs instead. Postgres always runs the .up.sql.
  const sqliteVersions = isSqlite(db)
    ? new Set(allFiles.filter((f) => f.endsWith(".up.sqlite.sql")))
    : new Set<string>()

  let count = 0
  for (const file of files) {
    const version = file.replace(".up.sql", "")
    if (applied.has(version)) {
      console.log(`  skip  ${version}`)
      continue
    }

    console.log(`  applying ${version}...`)
    const sqliteFile = file.replace(/\.up\.sql$/, ".up.sqlite.sql")
    const source = sqliteVersions.has(sqliteFile) ? sqliteFile : file
    const sqlFile = await readFile(join(migrationsDir, source), "utf8")
    const statements = sqlFile.split(";").map((s) => s.trim()).filter((s) => s.length > 0)
    // One transaction per migration, together with its version record, so an
    // interrupted migration leaves nothing behind and is retried from the
    // start (DDL is transactional in both Postgres and SQLite). A statement
    // that can't run in a transaction, like CREATE INDEX CONCURRENTLY, needs
    // a different runner.
    await db.transaction().execute(async (tx) => {
      for (const stmt of statements) {
        await sql.raw(stmt).execute(tx)
      }
      await tx.insertInto("schema_migrations")
        .values({
          version,
          applied_at: new Date().toISOString(),
        })
        .execute()
    })

    count++
  }

  console.log(`\nDone — ${count} migration(s) applied`)  
}