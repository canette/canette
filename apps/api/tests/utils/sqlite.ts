import { Database as BunSQLite } from "bun:sqlite"
import { Kysely, SqliteDialect } from "kysely"
import type { Database } from "../../src/db/types"

/**
 * Wrap bun:sqlite's Database so that prepared statements expose the `reader`
 * boolean that Kysely's SqliteDriver uses to decide between `.all()` and
 * `.run()`.  Without it every query (including SELECT) falls through to
 * `.run()` which always returns `rows: []`.
 */
class BunSQLiteShim {
  constructor(private db: BunSQLite) {}

  prepare(sql: string) {
    const stmt = this.db.prepare(sql)
    // A statement reads rows when it has result columns: a SELECT, or a
    // write with RETURNING.
    const reader = stmt.columnNames.length > 0
    return Object.assign(stmt, { reader })
  }

  close() {
    this.db.close()
  }
}

export function createTestDb(): Kysely<Database> {
  const shim = new BunSQLiteShim(new BunSQLite(":memory:"))
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: shim as never }),
  })
}
