import { Pool } from "pg"
import { Kysely, PostgresDialect } from "kysely"
import type { Database } from "./types"

export type DB = Kysely<Database>

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db: DB = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})
