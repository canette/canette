import { Pool } from "pg"
import { Kysely, PostgresDialect } from "kysely"
import { readFileSync } from "fs"
import type { Database } from "./types"

export type DB = Kysely<Database>

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

function buildSslConfig(): object | undefined {
  const caFile = process.env.DATABASE_CA_CERT_FILE
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false"

  if (!caFile && rejectUnauthorized) return undefined

  if (!rejectUnauthorized) {
    console.warn("DATABASE_SSL_REJECT_UNAUTHORIZED=false: TLS certificate verification is disabled")
    return { rejectUnauthorized: false }
  }

  return {
    ca: readFileSync(caFile!, "utf8"),
    rejectUnauthorized: true,
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: buildSslConfig() })

export const db: DB = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})
