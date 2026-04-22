"use client"

import { useState } from "react"
import { signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"
import { GoogleIcon } from "@/components/icons/google-icon"

export function LoginForm({ githubEnabled, googleEnabled }: { githubEnabled: boolean; googleEnabled: boolean }) {
  const [githubLoading, setGithubLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const hasSocialProviders = githubEnabled || googleEnabled

  return (
    <div className="flex flex-col gap-3">
      {githubEnabled && (
        <Button
          className="w-full gap-3 bg-[#24292f] hover:bg-[#2f3439] text-white border border-white/10"
          disabled={githubLoading}
          onClick={() => {
            setGithubLoading(true)
            signIn.social({ provider: "github", callbackURL: `${window.location.origin}/dashboard` })
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
            signIn.social({ provider: "google", callbackURL: `${window.location.origin}/dashboard` })
          }}
        >
          {googleLoading ? <Loader2 className="size-4 animate-spin" /> : <GoogleIcon size={18} />}
          Continue with Google
        </Button>
      )}

      {hasSocialProviders && (
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="flex-1 border-t border-border" />
        </div>
      )}

      <Button asChild variant="outline" className="w-full">
        <a href="/login/email">Sign in with email</a>
      </Button>
    </div>
  )
}


