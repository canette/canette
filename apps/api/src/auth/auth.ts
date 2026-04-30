import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"
import { Pool } from "pg"
import { passwordPolicyPlugin } from "./password"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [process.env.UI_URL ?? "http://localhost:3000"],
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
  socialProviders: {
    ...(process.env.GITHUB_CLIENT_ID
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
          },
        }
      : {}),
    ...(process.env.GOOGLE_CLIENT_ID
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {}),
  },
  plugins: [passwordPolicyPlugin(), admin({ adminRole: "admin", defaultRole: "developer" })],
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      role: {
        type: "string" as const,
        defaultValue: "developer",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Promote the first registered user to admin.
          // A single atomic UPDATE avoids the race condition of a SELECT COUNT
          // followed by a separate insert — if two users sign up simultaneously,
          // only the one whose UPDATE executes first will find no existing admin
          // and be promoted; the other stays as developer.
          await pool.query(
            `UPDATE "user" SET role = 'admin' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')`,
            [user.id],
          )

          // Auto-create a personal team for every new user.
          const teamId = crypto.randomUUID()
          await pool.query(
            `INSERT INTO teams (id, name, is_personal, owner_id, created_at, updated_at)
             VALUES ($1, $2, TRUE, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [teamId, `${user.name}'s team`, user.id],
          )
          await pool.query(
            `INSERT INTO team_members (id, team_id, user_id, created_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [crypto.randomUUID(), teamId, user.id],
          )
        },
      },
    },
  },
})

type _Session = typeof auth.$Infer.Session
export type Session = {
  session: _Session["session"]
  user: _Session["user"] & { role: string }
}
