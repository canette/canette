import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { ForgotPasswordForm } from "./forgot-password-form"
import { fetchSignupSettings } from "@/lib/api"

export const dynamic = "force-dynamic"

export default async function ForgotPasswordPage() {
  const settings = await fetchSignupSettings()
  const emailEnabled = settings?.magicLinkEnabled ?? false

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Reset password</CardTitle>
          <CardDescription>
            {emailEnabled
              ? "Enter your email and we'll send you a reset link."
              : "Password resets require administrator assistance."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ForgotPasswordForm emailEnabled={emailEnabled} />
        </CardContent>
      </Card>
    </main>
  )
}
