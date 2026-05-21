"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { resetPassword } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordRequirements } from "@/components/ui/password-requirements"
import { FormError } from "@/components/ui/form-error"
import { validatePassword } from "@/lib/password"

export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  if (!token) {
    return (
      <>
        <p className="text-sm text-muted-foreground text-center">
          This reset link is invalid or has expired. Request a new one.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login/forgot-password">Request new link</Link>
        </Button>
      </>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const result = await resetPassword({ newPassword: password, token })
      if (result.error) {
        if (result.error.status === 400 || result.error.status === 404) {
          setError("This reset link has expired or already been used. Please request a new one.")
        } else {
          setError(result.error.message ?? "Failed to reset password")
        }
        return
      }
      router.push("/login/email?reset=1")
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
        />
        <PasswordRequirements password={password} />
      </div>
      {error && <FormError message={error} />}
      <Button
        type="submit"
        className="w-full"
        disabled={loading || validatePassword(password).length > 0}
      >
        {loading ? "Saving…" : "Set new password"}
      </Button>
    </form>
  )
}
