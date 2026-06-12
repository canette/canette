import type { DB } from "./db"

// supportsForUpdate returns true for dialects that support `SELECT ... FOR UPDATE`
// (PostgreSQL, MySQL). SQLite does not, and the test DB uses SQLite — so callers
// gate row-locking SELECTs behind this check. SQLite's single-writer model makes
// FOR UPDATE unnecessary in tests.
//
// We detect via the `supportsMultipleConnections` adapter property, which is the
// most stable difference between PostgresDialect (true) and SqliteDialect (false).
type AdapterLike = { supportsMultipleConnections: boolean }
type ExecutorLike = { adapter: AdapterLike }
type DbLike = { getExecutor(): ExecutorLike }

export function supportsForUpdate(db: DB | DbLike): boolean {
  return db.getExecutor().adapter.supportsMultipleConnections === true
}
