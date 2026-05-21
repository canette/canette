import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { EmailForm } from "./email-form"
import { fetchSignupSettings } from "@/lib/api"

export const dynamic = "force-dynamic"

export default async function EmailLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const [{ callbackURL, reset, signup }, initialSettings] = await Promise.all([
    searchParams,
    fetchSignupSettings(),
  ])

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">canette</CardTitle>
          <CardDescription>Continue with email</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {reset && (
            <p className="text-sm text-center text-muted-foreground rounded-md border border-border px-3 py-2">
              Password updated — sign in with your new password.
            </p>
          )}
          <EmailForm
            callbackURL={callbackURL}
            initialSettings={initialSettings}
            forceSignIn={!!reset}
            forceSignUp={!!signup && !reset}
          />
        </CardContent>
      </Card>
    </main>
  )
}
