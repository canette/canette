import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { EmailForm } from "./email-form"

export const dynamic = "force-dynamic"

export default function EmailLoginPage() {
  const signupEnabled = process.env.EMAIL_SIGNUP_ENABLED !== "false"

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">canette</CardTitle>
          <CardDescription>Sign in with your email</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <EmailForm signupEnabled={signupEnabled} />
        </CardContent>
      </Card>
    </main>
  )
}
