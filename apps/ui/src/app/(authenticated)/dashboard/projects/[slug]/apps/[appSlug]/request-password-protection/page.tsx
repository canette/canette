"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Bot, CircleCheck, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { FormError } from "@/components/ui/form-error"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"

// Same limit as the request_password_protection MCP tool (apps/api/src/services/mcp.ts).
// Enforced again here because the link's query string can be edited by hand.
const MAX_REASON = 300

export default function RequestPasswordProtectionPage() {
  const { app } = useAppContext()
  const searchParams = useSearchParams()
  // Agent-supplied text: rendered as plain text only, never as markup or a link.
  const reason = (searchParams.get("reason") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON)

  // Keyed on the app, so navigating to another app's link starts with a fresh form.
  return <RequestPasswordProtectionForm key={app.id} reason={reason} />
}

function RequestPasswordProtectionForm({ reason }: { reason: string }) {
  const { app, project } = useAppContext()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState("")
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [done, setDone] = useState(false)

  const isWeb = app.deploymentType === "web"

  useEffect(() => {
    if (!isWeb) return
    let current = true
    api.passwordGate.get(app.id).then((status) => {
      if (current) setEnabled(status.enabled)
    }).catch((e: unknown) => {
      if (current) setLoadError(e instanceof Error ? e.message : "Failed to load password protection")
    })
    return () => { current = false }
  }, [app.id, isWeb])

  async function handleSave() {
    setSaving(true)
    setSaveError("")
    try {
      await api.passwordGate.enable(app.id, password)
      setPassword("")
      setDone(true)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save password")
    } finally { setSaving(false) }
  }

  const settingsHref = `/dashboard/projects/${project.slug}/apps/${app.slug}/settings#access`

  if (!isWeb) {
    return (
      <div className="max-w-2xl">
        <FormError message="Password protection is only supported for web apps." />
      </div>
    )
  }

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            {enabled ? "Change the password for" : "Password-protect"} {app.name}
          </CardTitle>
          <CardDescription>
            An AI agent asked you to put this app&apos;s public URL behind a password. Visitors will need one shared
            password to reach it; scripts can send it with HTTP Basic auth (any username). The password goes straight
            to canette: it is stored hashed, never shown again and never sent to the agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {reason && (
            <div className="rounded-md border border-border bg-panel-soft px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                <Bot className="size-3.5" />
                Reason given by the agent
              </p>
              <p className="text-sm whitespace-pre-wrap break-words">{reason}</p>
            </div>
          )}

          {loadError && <FormError message={loadError} />}

          {done ? (
            <div className="flex items-start gap-2 rounded-md bg-success-soft px-3 py-3 text-sm text-success-text">
              <CircleCheck className="size-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Password saved.</p>
                <p>Go back to your agent and tell it you&apos;re done. Password protection takes effect on the next deployment, which the agent can start for you.</p>
              </div>
            </div>
          ) : enabled === null && !loadError ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => { e.preventDefault(); handleSave() }}
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="gate-password">Password</Label>
                  {enabled && <span className="text-xs text-muted-foreground">Replaces the current password and signs out existing visitors</span>}
                </div>
                <Input id="gate-password" type="password" autoComplete="new-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} className="font-mono text-sm" />
              </div>
              {saveError && <FormError message={saveError} />}
              <div>
                <Button type="submit" disabled={saving || !password}>
                  {saving ? "Saving…" : enabled ? "Change password" : "Enable password protection"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Password protection can also be changed or turned off under <Link href={settingsHref} className="underline underline-offset-2">Settings → Password protection</Link>.
      </p>
    </div>
  )
}
