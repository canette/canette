import { betterAuth } from "better-auth"
import { admin, magicLink, genericOAuth } from "better-auth/plugins"
import { Pool } from "pg"
import { passwordPolicyPlugin } from "./password"
import { createEmailProvider } from "./email"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const emailProvider = createEmailProvider()
export const emailProviderConfigured = emailProvider !== null

const oidcEnforce = process.env.OIDC_ENFORCE === "true"

const magicLinkPlugin = emailProvider && !oidcEnforce
  ? magicLink({
      disableSignUp: true,
      sendMagicLink: async ({ email, url }) => {
        await emailProvider.send({
          to: email,
          subject: "Your canette sign-in link",
          html: `<p>Click the link below to sign in to canette. The link expires in 15 minutes.</p><p><a href="${url}">${url}</a></p>`,
          text: `Sign in to canette: ${url}\n\nThis link expires in 15 minutes.`,
        })
      },
    })
  : null

const oidcPlugin = process.env.OIDC_CLIENT_ID
  ? genericOAuth({
      config: [
        {
          providerId: "oidc",
          clientId: process.env.OIDC_CLIENT_ID,
          clientSecret: process.env.OIDC_CLIENT_SECRET!,
          discoveryUrl: `${process.env.OIDC_ISSUER_URL}/.well-known/openid-configuration`,
          scopes: ["openid", "profile", "email"],
          pkce: true,
        },
      ],
    })
  : null

export const coreAuthOptions = {
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
  plugins: [
    passwordPolicyPlugin(),
    admin({ adminRole: "admin", defaultRole: "developer" }),
    ...(magicLinkPlugin ? [magicLinkPlugin] : []),
    ...(oidcPlugin ? [oidcPlugin] : []),
  ],
  emailAndPassword: {
    enabled: !oidcEnforce,
    ...(emailProvider
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            await emailProvider.send({
              to: user.email,
              subject: "Reset your canette password",
              html: `<p>Click the link below to reset your canette password. The link expires in 1 hour.</p><p><a href="${url}">${url}</a></p><p>If you did not request a password reset, you can ignore this email.</p>`,
              text: `Reset your canette password: ${url}\n\nThis link expires in 1 hour. If you did not request a password reset, ignore this email.`,
            })
          },
        }
      : {}),
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
}

export const auth = betterAuth({
  ...coreAuthOptions,
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [process.env.UI_URL ?? "http://localhost:3000"],
  socialProviders: {
    ...(process.env.GITHUB_CLIENT_ID && !oidcEnforce
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
          },
        }
      : {}),
    ...(process.env.GOOGLE_CLIENT_ID && !oidcEnforce
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {}),
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
