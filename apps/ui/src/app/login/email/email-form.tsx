"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { signIn, signUp } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PasswordRequirements } from "@/components/ui/password-requirements"
import { FormError } from "@/components/ui/form-error"
import { validatePassword } from "@/lib/password"

export function EmailForm({ signupEnabled }: { signupEnabled: boolean }) {
  const router = useRouter()
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      if (mode === "signup") {
        const result = await signUp.email({ name, email, password, callbackURL: "/dashboard" })
        if (result.error) { setError(result.error.message ?? "Sign up failed"); return }
      } else {
        const result = await signIn.email({ email, password, callbackURL: "/dashboard" })
        if (result.error) { setError(result.error.message ?? "Sign in failed"); return }
      }
      router.push("/dashboard")
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  function switchMode(next: "signin" | "signup") {
    setMode(next)
    setError("")
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === "signup" && (
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
            autoComplete={mode === "signup" ? "email" : "username"}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
          {mode === "signup" && <PasswordRequirements password={password} />}
        </div>
        {error && <FormError message={error} />}
        <Button
          type="submit"
          className="w-full"
          disabled={loading || (mode === "signup" && validatePassword(password).length > 0)}
        >
          {loading ? "…" : mode === "signup" ? "Create account" : "Sign in"}
        </Button>
      </form>

      {signupEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          {mode === "signin" ? (
            <>No account?{" "}
              <button type="button" onClick={() => switchMode("signup")} className="underline hover:text-foreground">
                Sign up
              </button>
            </>
          ) : (
            <>Already have an account?{" "}
              <button type="button" onClick={() => switchMode("signin")} className="underline hover:text-foreground">
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
