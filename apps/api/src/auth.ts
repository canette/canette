import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"
import { Pool } from "pg"
import { passwordPolicyPlugin } from "./password"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [process.env.UI_URL ?? "http://localhost:3000"],
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
  plugins: [passwordPolicyPlugin(), admin({ adminRole: "admin" })],
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
        },
      },
    },
  },
})

export type Session = typeof auth.$Infer.Session
