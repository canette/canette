"use client"

import { useState } from "react"
import Link from "next/link"
import { authClient, signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { KeyRound, Loader2 } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"
import { GoogleIcon } from "@/components/icons/google-icon"

export function LoginForm({
  githubEnabled,
  googleEnabled,
  emailEnabled,
  oidcEnabled,
  oidcDisplayName,
  oidcEnforced,
  signupEnabled,
  callbackURL,
}: {
  githubEnabled: boolean
  googleEnabled: boolean
  emailEnabled: boolean
  oidcEnabled: boolean
  oidcDisplayName: string
  oidcEnforced: boolean
  signupEnabled?: boolean
  callbackURL?: string
}) {
  const [githubLoading, setGithubLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [oidcLoading, setOidcLoading] = useState(false)

  const showGithub = githubEnabled && !oidcEnforced
  const showGoogle = googleEnabled && !oidcEnforced
  const showEmail = emailEnabled && !oidcEnforced
  const hasSocialProviders = showGithub || showGoogle || oidcEnabled
  const showDivider = hasSocialProviders && showEmail
  // Reject non-relative callbackURLs to prevent open redirect attacks.
  const dest = callbackURL?.startsWith("/") ? callbackURL : "/dashboard"
  const emailHref = callbackURL
    ? `/login/email?callbackURL=${encodeURIComponent(callbackURL)}`
    : "/login/email"

  return (
    <div className="flex flex-col gap-3">
      {oidcEnabled && (
        <Button
          variant="outline"
          className="w-full gap-3"
          disabled={oidcLoading}
          onClick={() => {
            setOidcLoading(true)
            authClient.signIn.oauth2({ providerId: "oidc", callbackURL: dest })
          }}
        >
          {oidcLoading ? <Loader2 className="size-4 animate-spin" /> : <KeyRound size={18} />}
          Continue with {oidcDisplayName}
        </Button>
      )}

      {showGithub && (
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

      {showGoogle && (
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

      {showEmail && (
        <Button asChild variant="outline" className="w-full">
          <Link href={emailHref}>Sign in with email</Link>
        </Button>
      )}

      {showEmail && signupEnabled && (
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


