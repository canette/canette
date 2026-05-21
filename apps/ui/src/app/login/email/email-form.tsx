"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { signIn, signUp } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordRequirements } from "@/components/ui/password-requirements"
import { FormError } from "@/components/ui/form-error"
import { validatePassword } from "@/lib/password"
import { getSignupSettings } from "@/lib/api"
import type { SignupSettings } from "@canette/types"

export function EmailForm({ callbackURL, initialSettings, forceSignIn, forceSignUp }: { callbackURL?: string; initialSettings?: SignupSettings; forceSignIn?: boolean; forceSignUp?: boolean }) {
  const router = useRouter()
  const [settings, setSettings] = useState<SignupSettings | null>(initialSettings ?? null)
  const [formMode, setFormMode] = useState<"signin" | "signup" | "magic_link">(
    forceSignIn ? "signin" :
    forceSignUp ? "signup" :
    initialSettings?.magicLinkEnabled ? "magic_link" : "signin"
  )
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [error, setError] = useState("")

  const dest = callbackURL?.startsWith("/") ? callbackURL : "/dashboard"

  useEffect(() => {
    if (initialSettings) return
    getSignupSettings().then(s => {
      setSettings(s)
      if (s.magicLinkEnabled && !forceSignIn && !forceSignUp) setFormMode("magic_link")
    }).catch(() => setSettings({ mode: "open", magicLinkEnabled: false }))
  }, [initialSettings, forceSignIn])

  const signupEnabled = settings !== null && settings.mode !== "disabled"

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      if (formMode === "magic_link") {
        const result = await signIn.magicLink({ email, callbackURL: dest })
        if (result.error) { setError(result.error.message ?? "Failed to send magic link"); return }
        setMagicLinkSent(true)
        return
      }
      if (formMode === "signup") {
        // Pass inviteCode in the request body when mode requires it
        const extra = settings?.mode === "invite_code" ? { inviteCode } : {}
        const result = await signUp.email({ name, email, password, callbackURL: dest, ...extra })
        if (result.error) {
          if (result.error.status === 403) {
            setError(settings?.mode === "invite_code"
              ? "Invalid invite code — double-check it or contact your administrator."
              : "Sign-up is not allowed on this instance.")
          } else {
            setError(result.error.message ?? "Sign up failed")
          }
          return
        }
      } else {
        const result = await signIn.email({ email, password, callbackURL: dest })
        if (result.error) { setError(result.error.message ?? "Sign in failed"); return }
      }
      router.push(dest)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  function switchFormMode(next: "signin" | "signup" | "magic_link") {
    setFormMode(next)
    setError("")
    setMagicLinkSent(false)
  }

  if (magicLinkSent) {
    return (
      <>
        <p className="text-center text-sm text-muted-foreground">
          Check your email — we sent a sign-in link to <strong>{email}</strong>.
        </p>
        <p className="text-center text-sm text-muted-foreground">
          <button type="button" onClick={() => switchFormMode("signin")} className="underline hover:text-foreground">
            ← Back to sign in
          </button>
        </p>
      </>
    )
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {formMode === "signup" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete={formMode === "signup" ? "email" : "username"}
          />
        </div>
        {formMode !== "magic_link" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              {formMode === "signin" && (
                <Link href="/login/forgot-password" className="text-xs text-muted-foreground underline hover:text-foreground">
                  Forgot password?
                </Link>
              )}
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={formMode === "signup" ? "new-password" : "current-password"}
            />
            {formMode === "signup" && <PasswordRequirements password={password} />}
          </div>
        )}
        {formMode === "signup" && settings?.mode === "invite_code" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-code">Invite code</Label>
            <Input
              id="invite-code"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
        )}
        {error && <FormError message={error} />}
        <Button
          type="submit"
          className="w-full"
          disabled={
            loading ||
            (formMode === "signup" && validatePassword(password).length > 0) ||
            (formMode === "signup" && settings?.mode === "invite_code" && !inviteCode)
          }
        >
          {loading
            ? "…"
            : formMode === "signup"
              ? "Create account"
              : formMode === "magic_link"
                ? "Send magic link"
                : "Sign in"}
        </Button>
      </form>

      {settings?.magicLinkEnabled && formMode !== "magic_link" && (
        <>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>
          <Button variant="outline" className="w-full" onClick={() => switchFormMode("magic_link")}>
            Sign in with magic link
          </Button>
        </>
      )}

      {formMode === "magic_link" && (
        <p className="text-center text-sm text-muted-foreground">
          <button type="button" onClick={() => switchFormMode("signin")} className="underline hover:text-foreground">
            ← Sign in with password instead
          </button>
        </p>
      )}

      {signupEnabled && formMode !== "magic_link" && (
        <p className="text-center text-sm text-muted-foreground">
          {formMode === "signin" ? (
            <>No account?{" "}
              <button type="button" onClick={() => switchFormMode("signup")} className="underline hover:text-foreground">
                Sign up
              </button>
            </>
          ) : (
            <>Already have an account?{" "}
              <button type="button" onClick={() => switchFormMode("signin")} className="underline hover:text-foreground">
                Sign in
              </button>
            </>
          )}
        </p>
      )}

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="underline hover:text-foreground">← Other sign in options</Link>
      </p>
    </>
  )
}
