// isUniqueConstraintError reports whether a query failed on a unique
// constraint or index. Matches both SQLite ("UNIQUE constraint failed") and
// PostgreSQL ("duplicate key value violates unique constraint").
export function isUniqueConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : ""
  return msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("duplicate key")
}
