"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import * as api from "@/lib/api"
import type { ResourceDefaults, ScanPolicy, WebhookSettings } from "@canette/types"

export default function AdminSettingsPage() {
  const [scanPolicy, setScanPolicy] = useState<ScanPolicy | null>(null)
  const [policyDraft, setPolicyDraft] = useState<ScanPolicy | null>(null)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [policyError, setPolicyError] = useState("")

  const [webhookSettings, setWebhookSettings] = useState<WebhookSettings | null>(null)
  const [resourceDefaults, setResourceDefaults] = useState<ResourceDefaults | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([api.admin.getScanPolicy(), api.admin.getWebhookSettings(), api.admin.getResourceDefaults()])
      .then(([p, wh, rd]) => { setScanPolicy(p); setPolicyDraft(p); setWebhookSettings(wh); setResourceDefaults(rd) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleSavePolicy() {
    if (!policyDraft) return
    setPolicyError("")
    setSavingPolicy(true)
    try {
      const updated = await api.admin.updateScanPolicy(policyDraft)
      setScanPolicy(updated)
      setPolicyDraft(updated)
    } catch (e: unknown) {
      setPolicyError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSavingPolicy(false)
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error) return <p className="text-destructive text-sm">{error}</p>

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">System configuration and security policy.</p>
      </div>

      <div className="flex flex-col gap-8">

        {/* Security */}
        <section>
          <h2 className="text-sm font-medium mb-4">Image scanning (experimental)</h2>
          {policyDraft && (
            <div className="rounded-lg border border-border p-6 flex flex-col gap-5">
              <p className="text-sm text-muted-foreground">
                Run Trivy against each built image before deployment. Generates a CycloneDX SBOM and
                optionally blocks deployment when findings exceed the configured severity threshold.
              </p>
              <div className="flex flex-col gap-4">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm">Enable scanning</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={policyDraft.enabled}
                    onClick={() => setPolicyDraft((d) => d && { ...d, enabled: !d.enabled })}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none ${policyDraft.enabled ? "bg-foreground" : "bg-input"}`}
                  >
                    <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${policyDraft.enabled ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                </label>

                {policyDraft.enabled && (
                  <>
                    <label className="flex items-center justify-between gap-3">
                      <div>
                        <span className="text-sm">Mandatory (blocking)</span>
                        <p className="text-xs text-muted-foreground mt-0.5">Block deployment when scan finds issues above the threshold</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={policyDraft.mandatory}
                        onClick={() => setPolicyDraft((d) => d && { ...d, mandatory: !d.mandatory })}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none ${policyDraft.mandatory ? "bg-foreground" : "bg-input"}`}
                      >
                        <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${policyDraft.mandatory ? "translate-x-4" : "translate-x-0"}`} />
                      </button>
                    </label>

                    {policyDraft.mandatory && (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-sm">Block on severity</span>
                          <p className="text-xs text-muted-foreground mt-0.5">Block deployment when this severity or higher is found</p>
                        </div>
                        <Select
                          value={policyDraft.failSeverity}
                          onValueChange={(v) => setPolicyDraft((d) => d && { ...d, failSeverity: v as ScanPolicy["failSeverity"] })}
                        >
                          <SelectTrigger className="w-32 h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                            <SelectItem value="HIGH">HIGH</SelectItem>
                            <SelectItem value="MEDIUM">MEDIUM</SelectItem>
                            <SelectItem value="LOW">LOW</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </>
                )}
              </div>
              {policyError && <p className="text-sm text-destructive">{policyError}</p>}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleSavePolicy}
                  disabled={savingPolicy || JSON.stringify(policyDraft) === JSON.stringify(scanPolicy)}
                >
                  {savingPolicy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
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
