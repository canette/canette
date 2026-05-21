"use client"

import { useState } from "react"
import Link from "next/link"
import { requestPasswordReset } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FormError } from "@/components/ui/form-error"

export function ForgotPasswordForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const result = await requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/login/reset-password`,
      })
      if (result.error) {
        setError(result.error.message ?? "Failed to send reset email")
        return
      }
      setSent(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  if (!emailEnabled) {
    return (
      <>
        <p className="text-sm text-muted-foreground text-center">
          No email provider is configured on this instance. Contact your administrator to reset your password.
        </p>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login/email" className="underline hover:text-foreground">← Back to sign in</Link>
        </p>
      </>
    )
  }

  if (sent) {
    return (
      <>
        <p className="text-sm text-muted-foreground text-center">
          If <strong>{email}</strong> has an account, a reset link is on its way. Check your inbox.
        </p>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login/email" className="underline hover:text-foreground">← Back to sign in</Link>
        </p>
      </>
    )
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        {error && <FormError message={error} />}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Sending…" : "Send reset link"}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login/email" className="underline hover:text-foreground">← Back to sign in</Link>
      </p>
    </>
  )
}
