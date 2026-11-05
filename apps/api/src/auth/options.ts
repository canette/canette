// Shared better-auth options with no side effects (no DB pool, no
// betterAuth() call), so tests can import them without constructing the
// Postgres-backed production instance in ./auth.
import { admin, magicLink, genericOAuth } from "better-auth/plugins"
import { passwordPolicyPlugin } from "./password"
import { createEmailProvider } from "./email"

const emailProvider = createEmailProvider()
export const emailProviderConfigured = emailProvider !== null

export const oidcEnforce = process.env.OIDC_ENFORCE === "true"

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
