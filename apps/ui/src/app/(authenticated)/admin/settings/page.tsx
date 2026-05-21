"use client"

import { useEffect, useState } from "react"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/ui/form-error"
import * as api from "@/lib/api"
import type { AdminSignupSettings, ResourceDefaults, ScanInfo, WebhookSettings } from "@canette/types"
import { SkeletonText } from "@/components/ui/skeleton"

type SignupModeValue = "open" | "disabled" | "invite_code"

export default function AdminSettingsPage() {
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null)
  const [webhookSettings, setWebhookSettings] = useState<WebhookSettings | null>(null)
  const [resourceDefaults, setResourceDefaults] = useState<ResourceDefaults | null>(null)
  const [signupSettings, setSignupSettings] = useState<AdminSignupSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Signup form state
  const [signupMode, setSignupMode] = useState<SignupModeValue>("open")
  const [inviteCode, setInviteCode] = useState("")
  const [signupSaving, setSignupSaving] = useState(false)
  const [signupError, setSignupError] = useState("")
  const [signupSaved, setSignupSaved] = useState(false)

  useEffect(() => {
    Promise.all([
      api.admin.getSecurityInfo(),
      api.admin.getWebhookSettings(),
      api.admin.getResourceDefaults(),
      api.admin.getSignupSettings(),
    ])
      .then(([si, wh, rd, ss]) => {
        setScanInfo(si)
        setWebhookSettings(wh)
        setResourceDefaults(rd)
        setSignupSettings(ss)

        // Derive UI mode from the raw DB value
        if (ss.mode === "open" || ss.mode === "disabled") {
          setSignupMode(ss.mode)
        } else {
          setSignupMode("invite_code")
          setInviteCode(ss.mode)
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function saveSignupMode() {
    setSignupSaving(true)
    setSignupError("")
    setSignupSaved(false)
    try {
      const effectiveMode = signupMode === "invite_code" ? inviteCode : signupMode
      const updated = await api.admin.updateSignupSettings(effectiveMode)
      setSignupSettings(updated)
      setSignupSaved(true)
      setTimeout(() => setSignupSaved(false), 3000)
    } catch (e) {
      setSignupError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSignupSaving(false)
    }
  }

  if (loading) return <SkeletonText />
  if (error) return <p className="text-destructive text-sm">{error}</p>

  const isHelmDisabled = signupSettings?.helmDisabled ?? false

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">System configuration and security policy.</p>
      </div>

      <div className="flex flex-col gap-8">

        {/* Signup */}
        <section>
          <h2 className="text-sm font-medium mb-4">Signup</h2>
          <div className="rounded-lg border border-border p-6 flex flex-col gap-4">
            {isHelmDisabled ? (
              <p className="text-sm text-muted-foreground">
                Email signup is globally disabled via Helm (<code className="text-xs">api.disableEmailSignup=true</code>)
                and cannot be changed at runtime.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Control how new users can register. Existing users can always log in regardless of this setting.
                </p>

                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Signup mode</p>
                    <Select value={signupMode} onValueChange={(v) => setSignupMode(v as SignupModeValue)}>
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open — anyone can sign up</SelectItem>
                        <SelectItem value="disabled">Disabled — no new accounts</SelectItem>
                        <SelectItem value="invite_code">Invite code</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {signupMode === "invite_code" && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Invite code (min. 8 characters)</p>
                      <div className="flex items-center gap-2">
                        <Input
                          value={inviteCode}
                          onChange={(e) => setInviteCode(e.target.value)}
                          placeholder="Enter invite code"
                          className="w-72 font-mono"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
                            const limit = Math.floor(256 / chars.length) * chars.length
                            const out: string[] = []
                            while (out.length < 16) {
                              for (const b of crypto.getRandomValues(new Uint8Array(32)))
                                if (b < limit && out.length < 16) out.push(chars[b % chars.length])
                            }
                            setInviteCode(out.join(""))
                          }}
                        >
                          Generate
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-1">
                    <Button
                      size="sm"
                      onClick={saveSignupMode}
                      disabled={signupSaving || (signupMode === "invite_code" && inviteCode.length < 8)}
                    >
                      {signupSaving ? "Saving…" : "Save"}
                    </Button>
                    {signupSaved && <span className="text-sm text-muted-foreground">Saved</span>}
                  </div>

                  {signupError && <FormError message={signupError} />}
                </div>

                <Separator />

                <div>
                  <p className="text-xs text-muted-foreground mb-1">Email provider</p>
                  <p className="text-sm font-mono">
                    {signupSettings?.emailProviderConfigured
                      ? <span className="text-green-600 dark:text-green-400">configured</span>
                      : <span className="text-muted-foreground">none — magic link login disabled</span>}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Configured via Helm values (<code className="text-xs">api.email.provider</code>).
                  </p>
                </div>
              </>
            )}
          </div>
        </section>

        <Separator />

        {/* Security */}
        <section>
          <h2 className="text-sm font-medium mb-4">Image scanning</h2>
          <div className="rounded-lg border border-border p-6 flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Scan configuration is set via Helm values (<code className="text-xs">security.scan</code>) and
              cannot be changed at runtime.{" "}
              <a href="https://canette.dev/docs/self-hosting/helm" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">View docs</a>
            </p>
            {scanInfo && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Provider</p>
                  <p className="font-mono text-sm capitalize">{scanInfo.provider}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Enabled</p>
                  <p className="font-mono text-sm">{scanInfo.enabled ? "yes" : "no"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Mandatory (blocking)</p>
                  <p className="font-mono text-sm">{scanInfo.mandatory ? "yes" : "no"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Block on severity</p>
                  <p className="font-mono text-sm">{scanInfo.failSeverity}</p>
                </div>
              </div>
            )}
          </div>
        </section>

        <Separator />

        {/* Webhooks */}
        <section>
          <h2 className="text-sm font-medium mb-4">Webhooks</h2>
          <div className="rounded-lg border border-border p-6 flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Webhook settings are configured via Helm values and cannot be changed at runtime.
              Set <code className="text-xs">api.webhookBaseUrl</code> in your Helm values to override
              the base URL used when registering webhooks with git providers.{" "}
              <a href="https://canette.dev/docs/getting-started/webhooks" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">View docs</a>
            </p>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Webhook base URL</p>
              <p className="font-mono text-sm">
                {webhookSettings?.baseUrl || <span className="text-muted-foreground">(uses UI hostname)</span>}
              </p>
            </div>
          </div>
        </section>

        <Separator />

        {/* Resource defaults */}
        <section>
          <h2 className="text-sm font-medium mb-4">Resource defaults</h2>
          <div className="rounded-lg border border-border p-6 flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Default CPU and memory allocations applied to every app deployment when no per-app override
              is set. Configured via Helm values (<code className="text-xs">api.defaultResources</code>)
              and cannot be changed at runtime.{" "}
              <a href="https://canette.dev/docs/self-hosting/helm" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">View docs</a>
            </p>
            {resourceDefaults && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">CPU request</p>
                  <p className="font-mono text-sm">{resourceDefaults.cpuRequest}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">CPU limit</p>
                  <p className="font-mono text-sm">{resourceDefaults.cpuLimit}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Memory request</p>
                  <p className="font-mono text-sm">{resourceDefaults.memoryRequest}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Memory limit</p>
                  <p className="font-mono text-sm">{resourceDefaults.memoryLimit}</p>
                </div>
              </div>
            )}
          </div>
        </section>

      </div>
    </>
  )
}
