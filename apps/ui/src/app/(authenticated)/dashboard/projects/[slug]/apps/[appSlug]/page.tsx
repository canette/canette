"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { ArrowLeft, ChevronDown, Download, ExternalLink, Eye, EyeOff, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppShell } from "@/components/app-shell"
import * as api from "@/lib/api"
import type { App, AppSecret, BuildLog, Deployment, EnvVar, GitCredential, ScanSummary } from "@canette/types"

// ── helpers ──────────────────────────────────────────────────────────────────

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"

function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building") return "building"
  if (status === "scanning") return "building"
  if (status === "pending_deployment") return "deploying"
  if (status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "stopped") return "secondary"
  return "pending"
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function shortSha(sha: string) { return sha.slice(0, 7) }

function parseScanSummary(json: string | undefined): ScanSummary | null {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

function ScanBadge({ deployment }: { deployment: Deployment }) {
  const summary = parseScanSummary(deployment.scanSummary as string | undefined)
  if (!deployment.scanStatus || deployment.scanStatus === "skipped") return null
  if (deployment.scanStatus === "error") {
    return <span className="text-xs text-muted-foreground">Scan error</span>
  }
  const counts = summary
    ? `${summary.critical}C ${summary.high}H ${summary.medium}M`
    : ""
  const color = deployment.scanStatus === "fail"
    ? "text-red-600"
    : "text-green-600"
  return (
    <span className={`text-xs ${color} shrink-0`}>
      Scan: {counts || (deployment.scanStatus === "pass" ? "clean" : "failed")}
    </span>
  )
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── log dialog ───────────────────────────────────────────────────────────────

function LogDialog({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
  const [logs, setLogs] = useState<BuildLog[]>([])
  const [loading, setLoading] = useState(true)
  const isTerminal = deployment.status === "live" || deployment.status === "failed" || deployment.status === "stopped"
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function fetchLogs() {
      try {
        const d = await api.deployments.logs(deployment.id)
        if (!cancelled) setLogs(d.items)
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchLogs()
    if (isTerminal) return
    const interval = setInterval(fetchLogs, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [deployment.id, isTerminal])

  useEffect(() => {
    if (!userScrolledUp.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [logs])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48
  }

  function downloadLogs() {
    const text = logs.map((l) => l.line).join("\n")
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `build-${shortSha(deployment.commitSha)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <DialogContent className="max-h-[80vh] flex flex-col" aria-describedby="{undefined}">
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="font-mono text-sm">
          Logs — {shortSha(deployment.commitSha)}
          {deployment.commitMessage && (
            <span className="ml-2 text-muted-foreground font-sans font-normal">
              {deployment.commitMessage}
            </span>
          )}
        </DialogTitle>
        <div className="flex items-center gap-1">
          {isTerminal && !loading && logs.length > 0 && (
            <Button variant="ghost" size="icon" onClick={downloadLogs} className="h-7 w-7" title="Download logs">
              <span className="sr-only">Download logs</span>
              <Download size={14} />
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
              <span className="sr-only">Close</span>
              <X size={14} />
            </Button>
          </DialogClose>
        </div>
      </DialogHeader>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-6 pt-0">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            Loading logs…
          </div>
        ) : logs.length === 0 ? (
          !isTerminal ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              Waiting for logs…
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No logs available.</p>
          )
        ) : (
          <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">
            {logs.map((l) => l.line).join("\n")}
          </pre>
        )}
      </div>
    </DialogContent>
  )
}

// ── runtime log dialog ────────────────────────────────────────────────────────

function RuntimeLogDialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    const source = api.appLogs.stream(appId)

    source.onopen = () => setConnected(true)

    source.addEventListener("log", (e) => {
      setLines((prev) => {
        const next = [...prev, (e as MessageEvent).data]
        return next.length > 500 ? next.slice(-500) : next
      })
    })

    source.onerror = () => {
      setConnected(false)
      source.close()
    }

    // ping events keep the connection alive — no action needed in the UI
    source.addEventListener("ping", () => {})

    return () => source.close()
  }, [appId])

  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48
  }

  return (
    <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl" aria-describedby="{undefined}">
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="text-sm">App logs</DialogTitle>
        <DialogClose asChild>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
            <span className="sr-only">Close</span>
            <X size={14} />
          </Button>
        </DialogClose>
      </DialogHeader>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-6 pt-0">
        {!connected ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            Connecting…
          </div>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">No logs yet. They will appear here once the app starts generating output.</p>
        ) : (
          <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">
            {lines.join("\n")}
          </pre>
        )}
      </div>
    </DialogContent>
  )
}

// ── manifest dialog ────────────────────────────────────────────────────────────

function ManifestDialog({ deploymentId, onClose }: { deploymentId: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.deployments.manifest(deploymentId)
      .then((r) => setManifest(r.manifest))
      .catch(() => setManifest(null))
      .finally(() => setLoading(false))
  }, [deploymentId])

  return (
      <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl" aria-describedby="{undefined}">
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="text-sm">Applied manifest</DialogTitle>
        <DialogClose asChild>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
            <span className="sr-only">Close</span>
            <X size={14} />
          </Button>
        </DialogClose>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-6 pt-0">
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : manifest === null ? (
          <p className="text-muted-foreground text-sm">Manifest not available.</p>
        ) : (
          <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">{manifest}</pre>
        )}
      </div>
    </DialogContent>
  )
}

// ── env row ───────────────────────────────────────────────────────────────────

function EnvRow({
  label,
  value,
  isSecret,
  onSave,
  onDelete,
}: {
  label: string
  value: string
  isSecret: boolean
  onSave: (newValue: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
      setShowSecret(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setSaving(true)
    try {
      await onDelete()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-3 px-6 py-2.5 group">
      <span className="font-mono text-xs w-48 shrink-0 text-foreground/80">{label}</span>
      {isSecret ? (
        <div className="flex-1 flex items-center gap-2">
          {editing ? (
            <>
              <Input
                type={showSecret ? "text" : "password"}
                className="h-7 text-xs font-mono"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="text-muted-foreground hover:text-foreground shrink-0"
                tabIndex={-1}
                aria-label={showSecret ? "Hide value" : "Show value"}
              >
                {showSecret ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground font-mono select-none">••••••••</span>
          )}
        </div>
      ) : (
        <div className="flex-1">
          {editing ? (
            <Input
              className="h-7 text-xs font-mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          ) : (
            <span
              className="text-sm font-mono text-foreground/80 cursor-pointer hover:text-foreground"
              onClick={() => { setDraft(value); setEditing(true) }}
            >
              {value || <span className="text-muted-foreground italic">empty</span>}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {editing ? (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleSave} disabled={saving}>
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setEditing(false); setShowSecret(false) }} disabled={saving}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => { setDraft(isSecret ? "" : value); setEditing(true) }}
          >
            {isSecret ? "Update" : "Edit"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={handleDelete}
          disabled={saving}
        >
          ×
        </Button>
      </div>
    </div>
  )
}

// ── env card ──────────────────────────────────────────────────────────────────

function EnvCard({ appId, open, onToggle }: { appId: string; open: boolean; onToggle: () => void }) {
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [secrets, setSecrets] = useState<AppSecret[]>([])
  const [loading, setLoading] = useState(true)

  // add-row state
  const [addKey, setAddKey] = useState("")
  const [addValue, setAddValue] = useState("")
  const [addIsSecret, setAddIsSecret] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState("")

  const loadEnv = useCallback(async () => {
    try {
      const data = await api.env.list(appId)
      setEnvVars(data.envVars)
      setSecrets(data.secrets)
    } catch {
      // silently leave empty
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => { loadEnv() }, [loadEnv])

  async function handleAdd() {
    if (!addKey.trim() || !addValue.trim()) return
    setAddError("")
    setAdding(true)
    try {
      if (addIsSecret) {
        await api.env.putSecret(appId, addKey.trim(), addValue.trim())
      } else {
        await api.env.putVar(appId, addKey.trim(), addValue.trim())
      }
      setAddKey("")
      setAddValue("")
      setAddIsSecret(false)
      await loadEnv()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  const hasItems = envVars.length > 0 || secrets.length > 0

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
    <Card>
      <CollapsibleTrigger asChild>
        <CardHeader className="cursor-pointer select-none">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Environment</CardTitle>
            <Chevron open={open} />
          </div>
        </CardHeader>
      </CollapsibleTrigger>
      <CollapsibleContent>
      <CardContent className="p-0">
        <p className="text-sm text-muted-foreground px-6 pb-4">Variables are stored in plaintext. Secrets are encrypted at rest and never returned by the API.</p>
        {loading ? (
          <p className="text-muted-foreground text-sm px-6 pb-4">Loading…</p>
        ) : (
          <>
            {hasItems && (
              <>
                <div className="px-6 py-1.5 flex items-center gap-3 border-b border-border/50">
                  <span className="font-mono text-xs text-muted-foreground w-48">KEY</span>
                  <span className="text-xs text-muted-foreground">VALUE</span>
                </div>
                {envVars.map((v) => (
                  <EnvRow
                    key={v.id}
                    label={v.key}
                    value={v.value}
                    isSecret={false}
                    onSave={async (val) => {
                      await api.env.putVar(appId, v.key, val)
                      await loadEnv()
                    }}
                    onDelete={async () => {
                      await api.env.deleteVar(appId, v.key)
                      await loadEnv()
                    }}
                  />
                ))}
                {secrets.map((s) => (
                  <EnvRow
                    key={s.id}
                    label={s.key}
                    value=""
                    isSecret={true}
                    onSave={async (val) => {
                      await api.env.putSecret(appId, s.key, val)
                      await loadEnv()
                    }}
                    onDelete={async () => {
                      await api.env.deleteSecret(appId, s.key)
                      await loadEnv()
                    }}
                  />
                ))}
                <Separator />
              </>
            )}

            {/* Add row */}
            <div className="px-6 py-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 text-xs font-mono w-48 shrink-0"
                  placeholder="KEY"
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                />
                <Input
                  className="h-8 text-xs font-mono flex-1"
                  placeholder="value"
                  type={addIsSecret ? "password" : "text"}
                  value={addValue}
                  onChange={(e) => setAddValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAdd() }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant={addIsSecret ? "secondary" : "outline"}
                  className={cn("h-8 shrink-0 text-xs", addIsSecret && "border border-amber-500/50 text-amber-600")}
                  onClick={() => setAddIsSecret((v) => !v)}
                >
                  Secret
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={!addKey.trim() || !addValue.trim() || adding}
                  onClick={handleAdd}
                >
                  {adding ? "Adding…" : "Add"}
                </Button>
              </div>
              {addError && <p className="text-xs text-destructive">{addError}</p>}
            </div>
          </>
        )}
      </CardContent>
      </CollapsibleContent>
    </Card>
    </Collapsible>
  )
}

// ── webhook card ──────────────────────────────────────────────────────────────

interface WebhookConfig {
  appId: string
  provider: string
  watchPath: string
  autoRegistered: boolean
  verifiedAt?: string
  createdAt: string
  webhookUrl: string
}

interface WebhookCreateResult {
  config: WebhookConfig
  webhookUrl: string
  webhookSecret: string
  autoRegistered: boolean
  setupInstructions?: string
}

function WebhookCard({ appId, sourceType, defaultWatchPath, gitBranch, open, onToggle, onWebhookChange }: {
  appId: string
  sourceType: "git" | "image"
  defaultWatchPath?: string
  gitBranch?: string
  open: boolean
  onToggle: () => void
  onWebhookChange?: (exists: boolean) => void
}) {
  const [config, setConfig] = useState<WebhookConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [watchPath, setWatchPath] = useState(defaultWatchPath ?? "")
  const [enabling, setEnabling] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")

  // one-time secret dialog
  const [createResult, setCreateResult] = useState<WebhookCreateResult | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const cfg = await api.webhooks.get(appId)
      setConfig(cfg)
      setWatchPath(cfg.watchPath)
    } catch {
      setConfig(null)
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => { if (open) load() }, [open, load])

  async function handleEnable() {
    setError("")
    setEnabling(true)
    try {
      const result = await api.webhooks.create(appId, watchPath)
      setCreateResult(result)
      setConfig(result.config)
      onWebhookChange?.(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to enable webhook")
    } finally {
      setEnabling(false)
    }
  }

  async function handleDisable() {
    setError("")
    setDisabling(true)
    try {
      await api.webhooks.delete(appId)
      setConfig(null)
      setWatchPath("")
      onWebhookChange?.(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to disable webhook")
    } finally {
      setDisabling(false)
    }
  }

  async function copySecret(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setSecretCopied(true)
      setTimeout(() => setSecretCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
    <Card>
      <CollapsibleTrigger asChild>
        <CardHeader className="cursor-pointer select-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Webhook</CardTitle>
            {!loading && config && (
              (config.autoRegistered || config.verifiedAt) ? (
                <span className="text-xs px-1.5 py-0.5 rounded-full border border-transparent bg-green-500/15 text-green-400 font-semibold">
                  Active
                </span>
              ) : (
                <>
                  <span className="text-xs px-1.5 py-0.5 rounded-full border border-transparent bg-yellow-500/15 text-yellow-400 font-semibold">
                    Setup Pending
                  </span>
                  <button
                    type="button"
                    aria-label="Recheck webhook status"
                    disabled={refreshing}
                    onClick={async (e) => {
                      e.stopPropagation()
                      setRefreshing(true)
                      await load()
                      setRefreshing(false)
                    }}
                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
                  </button>
                </>
              )
            )}
          </div>
          <Chevron open={open} />
        </div>
        </CardHeader>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CardContent className="flex flex-col gap-4">
          {sourceType !== "git" ? (
            <p className="text-sm text-muted-foreground">Webhooks are only available for git-source apps.</p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : config ? (
            <>
              <div className="rounded-md border border-border bg-muted/30 p-4 flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground w-32 shrink-0">Provider</span>
                  <span className="font-medium capitalize">{config.provider}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground w-32 shrink-0">Registration</span>
                  <span className="flex items-center gap-2">
                    {config.autoRegistered ? "Auto-registered" : "Manual"}
                    {config.verifiedAt
                      ? <Badge variant="live">Verified</Badge>
                      : <Badge variant="muted">Pending</Badge>}
                  </span>
                </div>
                {gitBranch && (
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground w-32 shrink-0">Branch</span>
                    <code className="text-xs">{gitBranch}</code>
                  </div>
                )}
                {config.watchPath && (
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground w-32 shrink-0">Watch path</span>
                    <code className="text-xs">{config.watchPath}</code>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground w-32 shrink-0">Created</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(config.createdAt)}</span>
                </div>
              </div>
              {!config.autoRegistered && !config.verifiedAt && (
                <div className="rounded-md border border-border bg-muted/30 p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <TriangleAlert size={14} className="text-yellow-400 shrink-0" />
                    <p className="text-sm font-medium">Manual setup required</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This webhook was not registered automatically. Add the URL below to your repository settings to enable push-triggered deployments.
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 rounded border border-border bg-muted px-2 py-1 text-xs font-mono break-all text-foreground/80">
                      {config.webhookUrl}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 text-xs h-7"
                      onClick={() => navigator.clipboard.writeText(config.webhookUrl).catch(() => {})}
                    >
                      Copy
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The webhook secret was shown once at creation. If you&apos;ve lost it, disable and re-enable the webhook to get a new one.
                  </p>
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={handleDisable} disabled={disabling}>
                  {disabling ? "Disabling…" : "Disable webhook"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Automatically trigger a deployment on every push to the tracked branch.
                {gitBranch && (
                  <> Only pushes to <code className="text-xs text-foreground">{gitBranch}</code> will trigger a deployment.</>
                )}
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="watchPath">
                  Watch path
                  <span className="ml-2 text-xs text-muted-foreground font-normal">optional — trigger only when files under this path change</span>
                </Label>
                <Input
                  id="watchPath"
                  placeholder="packages/web"
                  value={watchPath}
                  onChange={(e) => setWatchPath(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button size="sm" onClick={handleEnable} disabled={enabling}>
                  {enabling ? "Enabling…" : "Enable webhook"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </CollapsibleContent>

      {/* One-time secret dialog */}
      <Dialog open={!!createResult} onOpenChange={(open) => { if (!open) setCreateResult(null) }}>
        {createResult && (
          <DialogContent className="max-w-lg" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="text-base">
                {createResult.autoRegistered ? "Webhook enabled" : "Manual setup required"}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 px-6 pb-6">
              {createResult.autoRegistered ? (
                <p className="text-sm text-muted-foreground">
                  The webhook was registered automatically in your git provider. Pushes to the tracked branch will now trigger deployments.                  
                </p>
              ) : (
                <div className="rounded-md border border-border bg-muted/30 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <TriangleAlert size={14} className="text-yellow-400 shrink-0" />
                    <p className="text-sm font-medium">Action required</p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Canette could not register the webhook automatically. Copy the URL and secret below and add them to your repository settings. Deployments will not trigger until you complete this step.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Payload URL</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono break-all">
                    {createResult.webhookUrl}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => navigator.clipboard.writeText(createResult.webhookUrl).catch(() => {})}
                  >
                    Copy
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  Webhook secret
                  <span className="text-yellow-400 font-medium">— copy now, shown once</span>
                </Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-xs font-mono break-all">
                    {createResult.webhookSecret}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => copySecret(createResult.webhookSecret)}
                  >
                    {secretCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </div>

              {createResult.setupInstructions && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Setup instructions</Label>
                  <pre className="rounded-md border border-border bg-muted px-3 py-3 text-xs font-mono whitespace-pre-wrap text-foreground/80">
                    {createResult.setupInstructions}
                  </pre>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => setCreateResult(null)}>
                  {createResult.autoRegistered ? "Done" : "I've set this up"}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </Card>
    </Collapsible>
  )
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function AppDetailPage() {
  const { slug: projectSlug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const router = useRouter()
  const [app, setApp] = useState<App | null>(null)
  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // settings form state
  const [name, setName] = useState("")
  const [sourceType, setSourceType] = useState<"git" | "image">("git")
  const [gitUrl, setGitUrl] = useState("")
  const [gitBranch, setGitBranch] = useState("")
  const [appPath, setAppPath] = useState("")
  const [imageUrl, setImageUrl] = useState("")
  const [imageTag, setImageTag] = useState("")
  const [port, setPort] = useState(3000)
  const [gitCredentialId, setGitCredentialId] = useState<string>("")
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  // canette config editor
const [canetteConfigDraft, setCanetteConfigDraft] = useState("")
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState("")
  const [configSaved, setConfigSaved] = useState(false)

  // action state
  const [deploying, setDeploying] = useState(false)
  const [redeploying, setRedeploying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [actionError, setActionError] = useState("")
  const [showRedeployPrompt, setShowRedeployPrompt] = useState(false)

  // webhook presence (used to lock the git URL field)
  const [hasWebhook, setHasWebhook] = useState(false)

  // collapsible cards
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [webhookOpen, setWebhookOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [configCardOpen, setConfigCardOpen] = useState(false)

  // delete state
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  // log dialog
  const [logDeployment, setLogDeployment] = useState<Deployment | null>(null)
  // runtime log dialog
  const [showRuntimeLogs, setShowRuntimeLogs] = useState(false)
  // manifest dialog
  const [manifestDeployment, setManifestDeployment] = useState<Deployment | null>(null)

  const loadDeployments = useCallback(async (appId: string) => {
    const data = await api.deployments.list(appId)
    setDeploymentList(data.items)
  }, [])

  const loadApp = useCallback(async () => {
    const a = await api.apps.getBySlug(projectSlug, appSlug)
    setApp(a)
  }, [projectSlug, appSlug])

  useEffect(() => {
    Promise.all([
      api.apps.getBySlug(projectSlug, appSlug),
      api.projects.listCredentials(projectSlug).catch(() => [] as GitCredential[]),
    ])
      .then(([a, creds]) => {
        setApp(a)
        setName(a.name)
        setSourceType(a.sourceType)
        setGitUrl(a.gitUrl)
        setGitBranch(a.gitBranch)
        setAppPath(a.appPath)
        setImageUrl(a.imageUrl)
        setImageTag(a.imageTag)
        setPort(a.port)
        setGitCredentialId(a.gitCredentialId ?? "")
        setCanetteConfigDraft(a.canetteConfig ?? "")
        setCredentials(creds)
        api.webhooks.get(a.id).then(() => setHasWebhook(true)).catch(() => setHasWebhook(false))
        return loadDeployments(a.id)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectSlug, appSlug, loadDeployments])

  const hasActiveDeployment = deploymentList.some(
    (d) => d.status === "pending_build" || d.status === "building" || d.status === "scanning" || d.status === "pending_deployment" || d.status === "deploying"
  )
  // liveDeployment: what is actually serving traffic right now.
  const liveDeployment = deploymentList.find(d => d.status === "live")
  // latestDeployment: the most recent by date — used for build logs and the build-status row.
  const latestDeployment = deploymentList[0]
  // currentDeployment: what the status header and action buttons represent.
  // Prefers the live deployment so that redeploy/stop always target the running app.
  const currentDeployment = liveDeployment ?? latestDeployment
  // Show a separate build-status row when a newer deployment exists alongside a live one.
  const showLatestBuildRow = !!(liveDeployment && latestDeployment && latestDeployment.id !== liveDeployment.id)
  const canRedeploy = !!(
    currentDeployment?.imageDigest &&
    !hasActiveDeployment &&
    (currentDeployment.status === "live" || currentDeployment.status === "failed" || currentDeployment.status === "stopped")
  )

  // Auto-refresh while any build/deploy is in progress.
  useEffect(() => {
    if (!app || !hasActiveDeployment) return
    const interval = setInterval(() => {
      loadDeployments(app.id)
      loadApp()
    }, 3000)
    return () => clearInterval(interval)
  }, [app, hasActiveDeployment, loadDeployments, loadApp])

  const isDirty = app && (
    name !== app.name ||
    sourceType !== app.sourceType ||
    gitUrl !== app.gitUrl ||
    gitBranch !== app.gitBranch ||
    appPath !== app.appPath ||
    imageUrl !== app.imageUrl ||
    imageTag !== app.imageTag ||
    port !== app.port ||
    gitCredentialId !== (app.gitCredentialId ?? "")
  )

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!app) return
    setSaveError("")
    setSaving(true)
    try {
      const credentialChanged = gitCredentialId !== (app.gitCredentialId ?? "")
      const updated = await api.apps.update(app.id, {
        name,
        sourceType,
        gitUrl: sourceType === "git" ? gitUrl : undefined,
        gitBranch: sourceType === "git" ? gitBranch : undefined,
        appPath: sourceType === "git" ? appPath : undefined,
        imageUrl: sourceType === "image" ? imageUrl : undefined,
        imageTag: sourceType === "image" ? imageTag : undefined,
        port,
        gitCredentialId: credentialChanged
          ? (gitCredentialId || null)
          : undefined,
      })
      setGitCredentialId(updated.gitCredentialId ?? "")
      setApp(updated)
      if (canRedeploy) setShowRedeployPrompt(true)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveConfig() {
    if (!app) return
    setConfigError("")
    setConfigSaved(false)
    setSavingConfig(true)
    try {
      const updated = await api.apps.update(app.id, {
        canetteConfig: canetteConfigDraft.trim() || null,
      })
      setApp(updated)
      setCanetteConfigDraft(updated.canetteConfig ?? "")
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleDelete() {
    if (!app) return
    setDeleteError("")
    setDeleting(true)
    try {
      await api.apps.delete(app.id)
      router.push(`/dashboard/projects/${projectSlug}`)
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed")
      setDeleting(false)
    }
  }

  async function handleDeploy() {
    if (!app) return
    setActionError("")
    setShowRedeployPrompt(false)
    setDeploying(true)
    try {
      await api.deployments.trigger(app.id)
      await Promise.all([loadDeployments(app.id), loadApp()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Deploy failed")
    } finally {
      setDeploying(false)
    }
  }

  async function handleRedeploy(deploymentId: string) {
    if (!app) return
    setActionError("")
    setShowRedeployPrompt(false)
    setRedeploying(true)
    try {
      await api.deployments.redeploy(deploymentId)
      await Promise.all([loadDeployments(app.id), loadApp()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Redeploy failed")
    } finally {
      setRedeploying(false)
    }
  }

  async function handleStop() {
    if (!app) return
    setActionError("")
    setStopping(true)
    try {
      await api.apps.stop(app.id)
      setShowStopConfirm(false)
      await Promise.all([loadDeployments(app.id), loadApp()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Stop failed")
    } finally {
      setStopping(false)
    }
  }

  if (loading) return <Shell projectSlug={projectSlug} appName={appSlug}><p className="text-muted-foreground text-sm">Loading…</p></Shell>
  if (error || !app) return <Shell projectSlug={projectSlug} appName={appSlug}><p className="text-destructive text-sm">{error || "App not found"}</p></Shell>

  return (
    <Shell projectSlug={projectSlug} appName={app.name} app={app}>
      <div className="flex flex-col gap-6">

        {/* Status card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <CardTitle className="text-base">Status</CardTitle>
                {currentDeployment ? (
                  <CardDescription>
                    <span className="font-mono">{shortSha(currentDeployment.commitSha)}</span>
                    {currentDeployment.commitMessage && ` — ${currentDeployment.commitMessage}`}
                    <span className="ml-2 text-xs">{timeAgo(currentDeployment.createdAt)}</span>
                  </CardDescription>
                ) : (
                  <CardDescription>Never deployed</CardDescription>
                )}
              </div>
              <Badge variant={currentDeployment ? statusVariant(currentDeployment.status) : "pending"}>
                {currentDeployment ? formatStatus(currentDeployment.status) : "Not deployed"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}
            {liveDeployment && app.liveUrl && (
              <a
                href={app.liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm font-mono hover:border-foreground/30 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                {app.liveUrl}
                <ExternalLink size={12} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
              </a>
            )}
            {showLatestBuildRow && latestDeployment && (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  <span className="font-mono">{shortSha(latestDeployment.commitSha)}</span>
                  {latestDeployment.commitMessage && (
                    <span className="ml-2">{latestDeployment.commitMessage}</span>
                  )}
                  <span className="ml-2 text-xs">{timeAgo(latestDeployment.createdAt)}</span>
                </span>
                <Badge variant={statusVariant(latestDeployment.status)}>
                  {formatStatus(latestDeployment.status)}
                </Badge>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              {canRedeploy ? (
                <>
                  <Button size="sm" onClick={() => handleRedeploy(currentDeployment!.id)} disabled={redeploying}>
                    {redeploying ? "Redeploying…" : "Redeploy"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDeploy} disabled={deploying}>
                    {app.sourceType === "git" ? "Rebuild" : "Deploy new"}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={handleDeploy} disabled={deploying || hasActiveDeployment}>
                  {deploying ? "Deploying…" : hasActiveDeployment ? "In progress…" : "Deploy"}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowStopConfirm(true)}
                disabled={stopping || !currentDeployment || (currentDeployment.status !== "live" && currentDeployment.status !== "failed")}
              >
                Stop
              </Button>
              {latestDeployment && (
                <Button size="sm" variant="ghost" onClick={() => setLogDeployment(latestDeployment)}>
                  Deploy logs
                </Button>
              )}
              {currentDeployment?.status === "live" && (
                <Button size="sm" variant="ghost" onClick={() => setShowRuntimeLogs(true)}>
                  App logs
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Deployments */}
        {deploymentList.length > 0 && (
          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer select-none">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Deployments</CardTitle>
                    <Chevron open={historyOpen} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="p-0">
                  {deploymentList.map((d, i) => (
                    <div key={d.id}>
                      {i > 0 && <Separator />}
                      <div className="flex items-center justify-between px-6 py-3">
                        <div className="flex items-center gap-3">
                          <Badge variant={statusVariant(d.status)}>{formatStatus(d.status)}</Badge>
                          <span className="font-mono text-xs text-muted-foreground">{shortSha(d.commitSha)}</span>
                          {d.commitMessage && (
                            <span className="text-sm text-foreground/80 truncate max-w-xs">{d.commitMessage}</span>
                          )}
                          <ScanBadge deployment={d} />
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs text-muted-foreground">{timeAgo(d.createdAt)}</span>
                          <Button size="sm" variant="ghost" onClick={() => setLogDeployment(d)}>
                            Logs
                          </Button>
                          {(d.status === "live") && (
                            <Button size="sm" variant="ghost" onClick={() => setManifestDeployment(d)}>
                              Manifest
                            </Button>
                          )}
                          {(d.scanStatus === "pass" || d.scanStatus === "fail") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                try {
                                  const { sbom } = await api.deployments.sbom(d.id)
                                  const blob = new Blob([sbom], { type: "application/json" })
                                  const url = URL.createObjectURL(blob)
                                  const a = document.createElement("a")
                                  a.href = url
                                  a.download = `sbom-${shortSha(d.commitSha)}.json`
                                  a.click()
                                  URL.revokeObjectURL(url)
                                } catch { /* no sbom */ }
                              }}
                            >
                              SBOM
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        )}

        {/* Settings card */}
        <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Settings</CardTitle>
                  <Chevron open={settingsOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <form onSubmit={handleSave} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
                  </div>

                  {/* Source type toggle */}
                  <div className="flex flex-col gap-1.5">
                    <Label>Source</Label>
                    <div className="flex rounded-md border border-border overflow-hidden w-fit">
                      <button
                        type="button"
                        onClick={() => setSourceType("git")}
                        className={cn(
                          "px-4 py-1.5 text-sm transition-colors",
                          sourceType === "git"
                            ? "bg-foreground text-background font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        Git
                      </button>
                      <button
                        type="button"
                        onClick={() => setSourceType("image")}
                        className={cn(
                          "px-4 py-1.5 text-sm transition-colors border-l border-border",
                          sourceType === "image"
                            ? "bg-foreground text-background font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        Docker Image
                      </button>
                    </div>
                  </div>

                  {sourceType === "git" ? (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="gitUrl">Git URL</Label>
                        <Input id="gitUrl" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} disabled={hasWebhook} />
                        {hasWebhook && (
                          <p className="text-xs text-muted-foreground">Remove the webhook before changing the repository URL.</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="gitBranch">Branch</Label>
                          <Input id="gitBranch" value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="appPath">
                            App path
                            <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                          </Label>
                          <Input id="appPath" placeholder="/" value={appPath} onChange={(e) => setAppPath(e.target.value)} />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="gitCredentialId">Credential</Label>
                        <Select
                          value={gitCredentialId || "__none__"}
                          onValueChange={(v) => setGitCredentialId(v === "__none__" ? "" : v)}
                        >
                          <SelectTrigger id="gitCredentialId">
                            <SelectValue placeholder="No credentials — public repo" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">No credentials — public repo</SelectItem>
                            {credentials.map((c) => (
                              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="imageUrl">Image</Label>
                        <Input id="imageUrl" placeholder="nginx" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="imageTag">Tag</Label>
                        <Input id="imageTag" placeholder="latest" value={imageTag} onChange={(e) => setImageTag(e.target.value)} />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="port">Port</Label>
                    <Input
                      id="port"
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                      className="w-32 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </div>

                  {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                  <div className="flex items-center justify-between gap-3">
                    {showRedeployPrompt && currentDeployment ? (
                      <p className="text-sm text-amber-600 flex items-center gap-2">
                        Settings saved — redeploy to apply changes.
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => { setShowRedeployPrompt(false); handleRedeploy(currentDeployment.id) }}
                        >
                          Redeploy
                        </Button>
                      </p>
                    ) : (
                      <span />
                    )}
                    <Button type="submit" size="sm" disabled={!isDirty || saving}>
                      {saving ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Environment card */}
        <EnvCard appId={app.id} open={envOpen} onToggle={() => setEnvOpen(o => !o)} />

        {/* Webhook card */}
        <WebhookCard
          appId={app.id}
          sourceType={app.sourceType}
          defaultWatchPath={app.appPath || undefined}
          gitBranch={app.gitBranch || undefined}
          open={webhookOpen}
          onToggle={() => setWebhookOpen(o => !o)}
          onWebhookChange={setHasWebhook}
        />

        {/* Advanced Configuration card */}
        <Collapsible open={configCardOpen} onOpenChange={setConfigCardOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Advanced Configuration</CardTitle>
                  <Chevron open={configCardOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Inline <code className="text-xs">canette.yaml</code> configuration. Applied at deploy time as the base layer — if your repo contains a <code className="text-xs">canette.yaml</code>, its fields take precedence over this config.
                </p>
                <Textarea
                  className="font-mono text-xs min-h-[180px]"
                  value={canetteConfigDraft}
                  onChange={(e) => setCanetteConfigDraft(e.target.value)}
                  placeholder={`resources:\n  requests:\n    cpu: "100m"\n    memory: "128Mi"\n  limits:\n    cpu: "500m"\n    memory: "512Mi"\nreplicas: 1`}
                  spellCheck={false}
                />
                {configError && <p className="text-sm text-destructive">{configError}</p>}
                {configSaved && <p className="text-sm text-green-600">Saved.</p>}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleSaveConfig}
                    disabled={savingConfig || canetteConfigDraft === (app?.canetteConfig ?? "")}
                  >
                    {savingConfig ? "Saving…" : "Save"}
                  </Button>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Danger Zone */}
        <Collapsible open={dangerOpen} onOpenChange={setDangerOpen}>
          <Card className="border-destructive/50">
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                  <Chevron open={dangerOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-medium mb-1">Delete app</p>
                  <p className="text-sm text-muted-foreground">
                    Permanently removes this app, all its deployments, environment variables, and
                    secrets. The deployed Kubernetes service will be torn down.
                  </p>
                </div>
                {(currentDeployment?.status === "live" || currentDeployment?.status === "deploying" || currentDeployment?.status === "building") && (
                  <p className="text-sm text-amber-600">
                    Stop the app before deleting it.
                  </p>
                )}
                <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                  <Checkbox
                    checked={deleteConfirmed}
                    onCheckedChange={(v) => setDeleteConfirmed(v === true)}
                    className="mt-0.5"
                  />
                  I understand this will permanently delete the app and all its data
                </label>
                {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
                <div className="flex justify-end">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={
                      !deleteConfirmed ||
                      deleting ||
                      currentDeployment?.status === "live" ||
                      currentDeployment?.status === "deploying" ||
                      currentDeployment?.status === "building"
                    }
                  >
                    {deleting ? "Deleting…" : "Delete app"}
                  </Button>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

      </div>

      {/* Build log dialog */}
      <Dialog open={!!logDeployment} onOpenChange={(open) => { if (!open) setLogDeployment(null) }}>
        {logDeployment && <LogDialog deployment={logDeployment} onClose={() => setLogDeployment(null)} />}
      </Dialog>

      {/* Runtime log dialog */}
      <Dialog open={showRuntimeLogs} onOpenChange={(open) => { if (!open) setShowRuntimeLogs(false) }}>
        {showRuntimeLogs && <RuntimeLogDialog appId={app.id} onClose={() => setShowRuntimeLogs(false)} />}
      </Dialog>

      {/* Manifest dialog */}
      <Dialog open={!!manifestDeployment} onOpenChange={(open) => { if (!open) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>

      {/* Stop confirmation dialog */}
      <Dialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <DialogContent className="max-w-sm" aria-describedby="{undefined}">
          <DialogHeader>
            <DialogTitle>Stop {app.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground px-6">
            This will take the app offline and delete the running Kubernetes deployment.
            You can redeploy at any time without rebuilding.
          </p>
          <div className="flex justify-end gap-2 px-6 pb-6 pt-2">
            <Button variant="outline" onClick={() => setShowStopConfirm(false)} disabled={stopping}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleStop} disabled={stopping}>
              {stopping ? "Stopping…" : "Stop app"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Shell>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size={16}
      className={`text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    />
  )
}

function Shell({ projectSlug, appName, app, children }: {
  projectSlug: string
  appName: string
  app?: App | null
  children: React.ReactNode
}) {
  const subtitle = app
    ? app.sourceType === "image"
      ? `${app.imageUrl}:${app.imageTag || "latest"}`
      : [app.gitUrl, app.gitBranch].filter(Boolean).join(" · ")
    : null

  return (
    <AppShell breadcrumb={[
      { label: projectSlug, href: `/dashboard/projects/${projectSlug}` },
      { label: appName },
    ]}>
      <div className="flex items-start gap-3 mb-6">
        <a href={`/dashboard/projects/${projectSlug}`} className="text-muted-foreground hover:text-foreground transition-colors mt-1">
          <ArrowLeft size={18} />
        </a>
        <div>
          <h1 className="text-xl font-semibold">{appName}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground font-mono mt-1 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {children}
    </AppShell>
  )
}
