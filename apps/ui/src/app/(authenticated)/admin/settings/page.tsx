"use client"

import { useEffect, useState } from "react"
import { Separator } from "@/components/ui/separator"
import * as api from "@/lib/api"
import type { ResourceDefaults, ScanInfo, WebhookSettings } from "@canette/types"
import { SkeletonText } from "@/components/ui/skeleton"

export default function AdminSettingsPage() {
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null)
  const [webhookSettings, setWebhookSettings] = useState<WebhookSettings | null>(null)
  const [resourceDefaults, setResourceDefaults] = useState<ResourceDefaults | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([api.admin.getSecurityInfo(), api.admin.getWebhookSettings(), api.admin.getResourceDefaults()])
      .then(([si, wh, rd]) => { setScanInfo(si); setWebhookSettings(wh); setResourceDefaults(rd) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonText />
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
