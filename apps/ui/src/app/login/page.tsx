import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { LoginForm } from "./login-form"
import { fetchSignupSettings } from "@/lib/api"

export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const githubEnabled = !!process.env.GITHUB_LOGIN_ENABLED && process.env.GITHUB_LOGIN_ENABLED !== "false"
  const googleEnabled = !!process.env.GOOGLE_LOGIN_ENABLED && process.env.GOOGLE_LOGIN_ENABLED !== "false"
  const emailEnabled = process.env.EMAIL_LOGIN_ENABLED !== "false"
  const oidcEnabled = process.env.OIDC_LOGIN_ENABLED === "true"
  const oidcDisplayName = process.env.OIDC_DISPLAY_NAME ?? "SSO"
  const oidcEnforced = process.env.OIDC_ENFORCE_ENABLED === "true"
  const [{ callbackURL }, signupSettings] = await Promise.all([
    searchParams,
    emailEnabled && !oidcEnforced ? fetchSignupSettings() : Promise.resolve(undefined),
  ])
  const signupEnabled = signupSettings?.mode !== "disabled"

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">canette</CardTitle>
          <CardDescription>Kubernetes Push-to-deploy Platform</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm
            githubEnabled={githubEnabled}
            googleEnabled={googleEnabled}
            emailEnabled={emailEnabled}
            oidcEnabled={oidcEnabled}
            oidcDisplayName={oidcDisplayName}
            oidcEnforced={oidcEnforced}
            signupEnabled={signupEnabled}
            callbackURL={callbackURL}
          />
        </CardContent>
      </Card>
    </main>
  )
}
