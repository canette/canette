import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CanetteLogo } from "@/components/canette-logo"
import { ResetPasswordForm } from "./reset-password-form"

export const dynamic = "force-dynamic"

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const { token } = await searchParams

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">New password</CardTitle>
          <CardDescription>Choose a strong password for your account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResetPasswordForm token={token} />
        </CardContent>
      </Card>
    </main>
  )
}
