import { Pool } from "pg"
import { Kysely, PostgresDialect } from "kysely"
import type { Database } from "./db-types"

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})

export type Db = typeof db
