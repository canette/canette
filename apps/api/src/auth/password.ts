import { createAuthMiddleware, APIError } from "better-auth/api"

export const PASSWORD_REQUIREMENTS = [
  { label: "At least 12 characters",       test: (p: string) => p.length >= 12 },
  { label: "At least one uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
  { label: "At least one lowercase letter", test: (p: string) => /[a-z]/.test(p) },
  { label: "At least one number",           test: (p: string) => /[0-9]/.test(p) },
]

export function validatePassword(password: string): string[] {
  return PASSWORD_REQUIREMENTS.filter((r) => !r.test(password ?? "")).map((r) => r.label)
}

export const passwordPolicyPlugin = () => ({
  id: "password-policy",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) =>
          ctx.path === "/sign-up/email" || ctx.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const password = ctx.body?.newPassword ?? ctx.body?.password
          const errors = validatePassword(password)
          if (errors.length > 0) {
            throw new APIError("BAD_REQUEST", {
              message: `Password must include: ${errors.join(", ")}`,
            })
          }
        }),
      },
    ],
  },
})
