import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { LoginForm } from "./login-form"

export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const githubEnabled = !!process.env.GITHUB_LOGIN_ENABLED && process.env.GITHUB_LOGIN_ENABLED !== "false"
  const googleEnabled = !!process.env.GOOGLE_LOGIN_ENABLED && process.env.GOOGLE_LOGIN_ENABLED !== "false"
  const emailEnabled = process.env.EMAIL_LOGIN_ENABLED !== "false"
  const { callbackURL } = await searchParams

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
          <LoginForm githubEnabled={githubEnabled} googleEnabled={googleEnabled} emailEnabled={emailEnabled} callbackURL={callbackURL} />
        </CardContent>
      </Card>
    </main>
  )
}
