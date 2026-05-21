"use client"

import { useState } from "react"
import Link from "next/link"
import { signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"
import { GoogleIcon } from "@/components/icons/google-icon"

export function LoginForm({
  githubEnabled,
  googleEnabled,
  emailEnabled,
  signupEnabled,
  callbackURL,
}: {
  githubEnabled: boolean
  googleEnabled: boolean
  emailEnabled: boolean
  signupEnabled?: boolean
  callbackURL?: string
}) {
  const [githubLoading, setGithubLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const hasSocialProviders = githubEnabled || googleEnabled
  const showDivider = hasSocialProviders && emailEnabled
  // Reject non-relative callbackURLs to prevent open redirect attacks.
  const dest = callbackURL?.startsWith("/") ? callbackURL : "/dashboard"
  const emailHref = callbackURL
    ? `/login/email?callbackURL=${encodeURIComponent(callbackURL)}`
    : "/login/email"

  return (
    <div className="flex flex-col gap-3">
      {githubEnabled && (
        <Button
          className="w-full gap-3 bg-[#24292f] hover:bg-[#2f3439] text-white border border-white/10"
          disabled={githubLoading}
          onClick={() => {
            setGithubLoading(true)
            signIn.social({ provider: "github", callbackURL: dest })
          }}
        >
          {githubLoading ? <Loader2 className="size-4 animate-spin" /> : <GitHubIcon size={18} />}
          Continue with GitHub
        </Button>
      )}

      {googleEnabled && (
        <Button
          variant="outline"
          className="w-full gap-3"
          disabled={googleLoading}
          onClick={() => {
            setGoogleLoading(true)
            signIn.social({ provider: "google", callbackURL: dest })
          }}
        >
          {googleLoading ? <Loader2 className="size-4 animate-spin" /> : <GoogleIcon size={18} />}
          Continue with Google
        </Button>
      )}

      {showDivider && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>
      )}

      {emailEnabled && (
        <Button asChild variant="outline" className="w-full">
          <Link href={emailHref}>Sign in with email</Link>
        </Button>
      )}

      {emailEnabled && signupEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          No account?{" "}
          <Link
            href={callbackURL ? `/login/email?signup=1&callbackURL=${encodeURIComponent(callbackURL)}` : "/login/email?signup=1"}
            className="underline hover:text-foreground"
          >
            Sign up
          </Link>
        </p>
      )}
    </div>
  )
}


