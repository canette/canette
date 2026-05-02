"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, Eye, EyeOff, RefreshCw, TriangleAlert } from "lucide-react"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { CredentialSelect } from "@/components/credential-select"
import { useAppContext } from "@/lib/app-context"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import type { AppSecret, EnvVar, GitCredential, WebhookConfig } from "@canette/types"

// ── section wrapper ───────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// ── env row ───────────────────────────────────────────────────────────────────

function EnvRow({ label, value, isSecret, onSave, onDelete }: {
  label: string; value: string; isSecret: boolean
  onSave: (v: string) => Promise<void>; onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  async function handleSave() {
    setSaving(true)
    try { await onSave(draft); setEditing(false); setShowSecret(false) }
    finally { setSaving(false) }
  }
  async function handleDelete() {
    setSaving(true)
    try { await onDelete() } finally { setSaving(false) }
  }

  return (
    <div className="flex items-center gap-3 px-6 py-2.5 group">
      <span className="font-mono text-xs w-48 shrink-0 text-foreground/80">{label}</span>
      {isSecret ? (
        <div className="flex-1 flex items-center gap-2">
          {editing ? (
            <>
              <Input type={showSecret ? "text" : "password"} className="h-7 text-xs font-mono" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
              <button type="button" onClick={() => setShowSecret((v) => !v)} className="text-muted-foreground hover:text-foreground shrink-0" tabIndex={-1}>
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
            <Input className="h-7 text-xs font-mono" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          ) : (
            <span className="text-sm font-mono text-foreground/80 cursor-pointer hover:text-foreground" onClick={() => { setDraft(value); setEditing(true) }}>
              {value || <span className="text-muted-foreground italic">empty</span>}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {editing ? (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleSave} disabled={saving}>Save</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setEditing(false); setShowSecret(false) }} disabled={saving}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setDraft(isSecret ? "" : value); setEditing(true) }}>
            {isSecret ? "Update" : "Edit"}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={handleDelete} disabled={saving}>×</Button>
      </div>
    </div>
  )
}

// ── env section ───────────────────────────────────────────────────────────────

function EnvSection({ appId }: { appId: string }) {
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [secrets, setSecrets] = useState<AppSecret[]>([])
  const [loading, setLoading] = useState(true)
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
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [appId])

  useEffect(() => { loadEnv() }, [loadEnv])

  async function handleAdd() {
    if (!addKey.trim() || !addValue.trim()) return
    setAddError("")
    setAdding(true)
    try {
      if (addIsSecret) await api.env.putSecret(appId, addKey.trim(), addValue.trim())
      else await api.env.putVar(appId, addKey.trim(), addValue.trim())
      setAddKey(""); setAddValue(""); setAddIsSecret(false)
      await loadEnv()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add")
    } finally { setAdding(false) }
  }

  const hasItems = envVars.length > 0 || secrets.length > 0

  return (
    <div className="flex flex-col gap-0">
      <p className="text-sm text-muted-foreground mb-4">Variables are stored in plaintext. Secrets are encrypted at rest and never returned by the API.</p>
      {loading ? (
        <Skeleton className="h-4 w-32" />
      ) : (
        <>
          {hasItems && (
            <>
              <div className="px-6 py-1.5 flex items-center gap-3 border-b border-border/50 -mx-6">
                <span className="font-mono text-xs text-muted-foreground uppercase w-48">Key</span>
                <span className="text-xs text-muted-foreground uppercase">Value</span>
              </div>
              <div className="-mx-6">
                {envVars.map((v) => (
                  <EnvRow key={v.id} label={v.key} value={v.value} isSecret={false}
                    onSave={async (val) => { await api.env.putVar(appId, v.key, val); await loadEnv() }}
                    onDelete={async () => { await api.env.deleteVar(appId, v.key); await loadEnv() }} />
                ))}
                {secrets.map((s) => (
                  <EnvRow key={s.id} label={s.key} value="" isSecret={true}
                    onSave={async (val) => { await api.env.putSecret(appId, s.key, val); await loadEnv() }}
                    onDelete={async () => { await api.env.deleteSecret(appId, s.key); await loadEnv() }} />
                ))}
              </div>
              <Separator className="-mx-6 w-[calc(100%+3rem)]" />
            </>
          )}
          <div className="flex flex-col gap-3 pt-4">
            <div className="flex items-center gap-2">
              <Input className="h-8 text-xs font-mono w-48 shrink-0" placeholder="KEY"
                value={addKey} onChange={(e) => setAddKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
              <Input className="h-8 text-xs font-mono flex-1" placeholder="value"
                type={addIsSecret ? "password" : "text"} value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd() }} />
              <Button type="button" size="sm" variant={addIsSecret ? "secondary" : "outline"}
                className={cn("h-8 shrink-0 text-xs", addIsSecret && "border border-amber-500/50 text-amber-600")}
                onClick={() => setAddIsSecret((v) => !v)}>Secret</Button>
              <Button type="button" size="sm" className="h-8 shrink-0"
                disabled={!addKey.trim() || !addValue.trim() || adding} onClick={handleAdd}>
                {adding ? "Adding…" : "Add"}
              </Button>
            </div>
            {addError && <p className="text-xs text-destructive">{addError}</p>}
          </div>
        </>
      )}
    </div>
  )
}

// ── webhook section ───────────────────────────────────────────────────────────

interface WebhookCreateResult {
  config: WebhookConfig
  webhookUrl: string
  webhookSecret: string
  autoRegistered: boolean
  setupInstructions?: string
}

function WebhookSection({ appId, sourceType, gitBranch, onWebhookChange }: {
  appId: string; sourceType: "git" | "image"; gitBranch?: string
  onWebhookChange?: (exists: boolean) => void
}) {
  const [config, setConfig] = useState<WebhookConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [watchPath, setWatchPath] = useState("")
  const [enabling, setEnabling] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [createResult, setCreateResult] = useState<WebhookCreateResult | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const cfg = await api.webhooks.get(appId)
      setConfig(cfg)
      setWatchPath(cfg.watchPath)
    } catch { setConfig(null) } finally { setLoading(false) }
  }, [appId])

  useEffect(() => { load() }, [load])

  async function handleEnable() {
    setError(""); setEnabling(true)
    try {
      const result = await api.webhooks.create(appId, watchPath)
      setCreateResult(result); setConfig(result.config); onWebhookChange?.(true)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed to enable webhook") }
    finally { setEnabling(false) }
  }

  async function handleDisable() {
    setError(""); setDisabling(true)
    try { await api.webhooks.delete(appId); setConfig(null); setWatchPath(""); onWebhookChange?.(false) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed to disable webhook") }
    finally { setDisabling(false) }
  }

  async function copySecret(text: string) {
    try { await navigator.clipboard.writeText(text); setSecretCopied(true); setTimeout(() => setSecretCopied(false), 2000) }
    catch { /* ignore */ }
  }

  if (sourceType !== "git") {
    return <p className="text-sm text-muted-foreground">Webhooks are only available for git-source apps.</p>
  }

  if (loading) return <Skeleton className="h-4 w-32" />

  return (
    <div className="flex flex-col gap-4">
      {config ? (
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
                {config.verifiedAt ? <Badge variant="live">Verified</Badge> : <Badge variant="muted">Pending</Badge>}
              </span>
              <button type="button" disabled={refreshing} onClick={async () => { setRefreshing(true); await load(); setRefreshing(false) }}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              </button>
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
          </div>
          {!config.autoRegistered && !config.verifiedAt && (
            <div className="rounded-md border border-border bg-muted/30 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <TriangleAlert size={14} className="text-yellow-400 shrink-0" />
                <p className="text-sm font-medium">Manual setup required</p>
              </div>
              <p className="text-xs text-muted-foreground">Add the URL below to your repository settings.</p>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 rounded border border-border bg-muted px-2 py-1 text-xs font-mono break-all text-foreground/80">{config.webhookUrl}</code>
                <Button size="sm" variant="outline" className="shrink-0 text-xs h-7" onClick={() => navigator.clipboard.writeText(config.webhookUrl).catch(() => {})}>Copy</Button>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={handleDisable} disabled={disabling}>{disabling ? "Disabling…" : "Disable webhook"}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Automatically trigger a deployment on every push to the tracked branch.
            {gitBranch && <> Only pushes to <code className="text-xs text-foreground">{gitBranch}</code> will trigger a deployment.</>}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="watchPath">Watch path <span className="text-xs text-muted-foreground font-normal">optional — trigger only when files under this path change</span></Label>
            <Input id="watchPath" placeholder="packages/web" value={watchPath} onChange={(e) => setWatchPath(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleEnable} disabled={enabling}>{enabling ? "Enabling…" : "Enable webhook"}</Button>
          </div>
        </>
      )}

      <Dialog open={!!createResult} onOpenChange={(open) => { if (!open) setCreateResult(null) }}>
        {createResult && (
          <DialogContent className="max-w-lg" aria-describedby={undefined}>
            <DialogHeader><DialogTitle className="text-base">{createResult.autoRegistered ? "Webhook enabled" : "Manual setup required"}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-4 px-6 pb-6">
              {createResult.autoRegistered ? (
                <p className="text-sm text-muted-foreground">The webhook was registered automatically. Pushes to the tracked branch will now trigger deployments.</p>
              ) : (
                <div className="rounded-md border border-border bg-muted/30 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <TriangleAlert size={14} className="text-yellow-400 shrink-0" />
                    <p className="text-sm font-medium">Action required</p>
                  </div>
                  <p className="text-sm text-muted-foreground">Copy the URL and secret below and add them to your repository settings.</p>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Payload URL</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono break-all">{createResult.webhookUrl}</code>
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigator.clipboard.writeText(createResult.webhookUrl).catch(() => {})}>Copy</Button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">Webhook secret <span className="text-yellow-400 font-medium">— copy now, shown once</span></Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-xs font-mono break-all">{createResult.webhookSecret}</code>
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => copySecret(createResult.webhookSecret)}>{secretCopied ? "Copied!" : "Copy"}</Button>
                </div>
              </div>
              {createResult.setupInstructions && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Setup instructions</Label>
                  <pre className="rounded-md border border-border bg-muted px-3 py-3 text-xs font-mono whitespace-pre-wrap text-foreground/80">{createResult.setupInstructions}</pre>
                </div>
              )}
              <div className="flex justify-end">
                <Button onClick={() => setCreateResult(null)}>{createResult.autoRegistered ? "Done" : "I've set this up"}</Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

// ── settings page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { slug: projectSlug } = useParams<{ slug: string; appSlug: string }>()
  const router = useRouter()
  const { app, project, refresh } = useAppContext()

  // General settings
  const [name, setName] = useState(app.name)
  const [sourceType, setSourceType] = useState<"git" | "image">(app.sourceType)
  const [gitUrl, setGitUrl] = useState(app.gitUrl)
  const [gitBranch, setGitBranch] = useState(app.gitBranch)
  const [appPath, setAppPath] = useState(app.appPath)
  const [imageUrl, setImageUrl] = useState(app.imageUrl)
  const [imageTag, setImageTag] = useState(app.imageTag)
  const [port, setPort] = useState(app.port)
  const [gitCredentialId, setGitCredentialId] = useState(app.gitCredentialId ?? "")
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [hasWebhook, setHasWebhook] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [savedMsg, setSavedMsg] = useState("")

  // Advanced config
  const [canetteConfigDraft, setCanetteConfigDraft] = useState(app.canetteConfig ?? "")
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState("")
  const [configSaved, setConfigSaved] = useState(false)

  // Danger zone
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  useEffect(() => {
    api.projects.listCredentials(projectSlug).then(setCredentials).catch(() => {})
    api.webhooks.get(app.id).then(() => setHasWebhook(true)).catch(() => setHasWebhook(false))
  }, [projectSlug, app.id])

  const isDirty = (
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
    setSaveError(""); setSavedMsg(""); setSaving(true)
    try {
      const credentialChanged = gitCredentialId !== (app.gitCredentialId ?? "")
      await api.apps.update(app.id, {
        name,
        sourceType,
        gitUrl: sourceType === "git" ? gitUrl : undefined,
        gitBranch: sourceType === "git" ? gitBranch : undefined,
        appPath: sourceType === "git" ? appPath : undefined,
        imageUrl: sourceType === "image" ? imageUrl : undefined,
        imageTag: sourceType === "image" ? imageTag : undefined,
        port,
        gitCredentialId: credentialChanged ? (gitCredentialId || null) : undefined,
      })
      await refresh()
      setSavedMsg("Settings saved — redeploy to apply changes.")
      setTimeout(() => setSavedMsg(""), 5000)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed")
    } finally { setSaving(false) }
  }

  async function handleSaveConfig() {
    setConfigError(""); setConfigSaved(false); setSavingConfig(true)
    try {
      await api.apps.update(app.id, { canetteConfig: canetteConfigDraft.trim() || null })
      await refresh()
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (e: unknown) {
      setConfigError(e instanceof Error ? e.message : "Save failed")
    } finally { setSavingConfig(false) }
  }

  async function handleDelete() {
    setDeleteError(""); setDeleting(true)
    try {
      await api.apps.delete(app.id)
      router.push(`/dashboard/projects/${projectSlug}`)
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed")
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* General */}
      <Section title="General">
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Source</Label>
            <div className="flex rounded-md border border-border overflow-hidden w-fit">
              <button type="button" onClick={() => setSourceType("git")}
                className={cn("px-4 py-1.5 text-sm transition-colors",
                  sourceType === "git" ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                Git
              </button>
              <button type="button" onClick={() => setSourceType("image")}
                className={cn("px-4 py-1.5 text-sm transition-colors border-l border-border",
                  sourceType === "image" ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                Docker Image
              </button>
            </div>
          </div>

          {sourceType === "git" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gitUrl">Git URL</Label>
                <Input id="gitUrl" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} disabled={hasWebhook} />
                {hasWebhook && <p className="text-xs text-muted-foreground">Remove the webhook before changing the repository URL.</p>}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="gitBranch">Branch</Label>
                  <Input id="gitBranch" value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="appPath">App path <span className="text-xs text-muted-foreground font-normal">optional</span></Label>
                  <Input id="appPath" placeholder="/" value={appPath} onChange={(e) => setAppPath(e.target.value)} />
                </div>
              </div>
              <CredentialSelect credentials={credentials} value={gitCredentialId} onChange={setGitCredentialId} teamId={project.teamId} />
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
            <Input id="port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))}
              className="w-32 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
          </div>

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {savedMsg && <p className="text-sm text-amber-600">{savedMsg}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!isDirty || saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </div>
        </form>
      </Section>

      {/* Environment & Secrets */}
      <Section title="Environment & Secrets" description="Variables are available in the runtime environment.">
        <EnvSection appId={app.id} />
      </Section>

      {/* Webhooks */}
      <Section title="Webhook" description="Trigger deployments automatically on git push.">
        <WebhookSection appId={app.id} sourceType={app.sourceType} gitBranch={app.gitBranch || undefined}
          onWebhookChange={setHasWebhook} />
      </Section>

      {/* Advanced config */}
      <Section title="Advanced Configuration">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Inline <code className="text-xs">canette.yaml</code> configuration. Applied at deploy time as the base layer — if your repo contains a <code className="text-xs">canette.yaml</code>, its fields take precedence.
          </p>
          <Textarea className="font-mono text-xs min-h-[180px]" value={canetteConfigDraft}
            onChange={(e) => setCanetteConfigDraft(e.target.value)}
            placeholder={`resources:\n  requests:\n    cpu: "100m"\n    memory: "128Mi"\n  limits:\n    cpu: "500m"\n    memory: "512Mi"\nreplicas: 1`}
            spellCheck={false} />
          {configError && <p className="text-sm text-destructive">{configError}</p>}
          {configSaved && <p className="text-sm text-green-600">Saved.</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSaveConfig} disabled={savingConfig}>{savingConfig ? "Saving…" : "Save config"}</Button>
          </div>
        </div>
      </Section>

      {/* Danger zone */}
      <Collapsible>
        <Card className="border-destructive/30">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none hover:bg-muted/30 transition-colors rounded-lg [&[data-state=open]]:rounded-b-none">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                <ChevronDown size={15} className={cn("text-destructive/70 transition-transform [[data-state=open]_&]:rotate-180")} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="flex flex-col gap-4">
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Delete this app</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Remove all app data and Kubernetes resources. This cannot be undone.</p>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={deleteConfirmed} onCheckedChange={(v) => setDeleteConfirmed(!!v)} />
                <span className="text-sm">Yes, delete <strong>{app.name}</strong> and all its data</span>
              </label>
              {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
              <div className="flex justify-end">
                <Button variant="destructive" size="sm" disabled={!deleteConfirmed || deleting} onClick={handleDelete}>
                  {deleting ? "Deleting…" : "Delete app"}
                </Button>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  )
}
