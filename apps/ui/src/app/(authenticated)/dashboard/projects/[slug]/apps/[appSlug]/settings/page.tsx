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
import { ChevronDown, Eye, EyeOff, FileText, Folder, FolderX, RefreshCw, Trash2, TriangleAlert } from "lucide-react"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CredentialSelect } from "@/components/credential-select"
import { DeploymentTypeField } from "@/components/app-form-fields"
import { useAppContext } from "@/lib/app-context"
import { useSession } from "@/lib/auth-client"
import { HostnameManager } from "@/components/hostname-manager"
import { PasswordGateManager } from "@/components/password-gate-manager"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import type { AppSecret, AppVolume, EnvVar, GitCredential, VolumeType, WebhookConfig } from "@canette/types"

// ── section wrapper ───────────────────────────────────────────────────────────

function Section({ id, title, description, children }: { id?: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

// ── section nav (design's settings left rail) ─────────────────────────────────

const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "environment", label: "Environment" },
  { id: "volumes", label: "Volumes" },
  { id: "hostnames", label: "Custom domains" },
  { id: "access", label: "Password protection" },
  { id: "webhook", label: "Webhook" },
  { id: "advanced", label: "Advanced" },
  { id: "danger", label: "Danger zone" },
]

function SectionNav({ showHostnames, showAccessControl }: { showHostnames: boolean; showAccessControl: boolean }) {
  const sections = SETTINGS_SECTIONS
    .filter((s) => showHostnames || s.id !== "hostnames")
    .filter((s) => showAccessControl || s.id !== "access")
  return (
    <nav className="hidden lg:flex flex-col gap-px w-44 shrink-0 sticky top-6 self-start">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={cn(
            "px-2.5 py-1.5 rounded-md text-[13px] transition-colors",
            s.id === "danger"
              ? "text-destructive-text hover:bg-destructive-soft"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {s.label}
        </a>
      ))}
    </nav>
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
            <button type="button" className="text-sm font-mono text-foreground/80 cursor-pointer hover:text-foreground text-left" onClick={() => { setDraft(value); setEditing(true) }}>
              {value || <span className="text-muted-foreground italic">empty</span>}
            </button>
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
                className={cn("h-8 shrink-0 text-xs", addIsSecret && "bg-warning-soft text-warning-text ring-1 ring-inset ring-warning-line")}
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

// ── volume section ───────────────────────────────────────────────────────────

const VOLUME_TYPE_LABELS: Record<VolumeType, string> = {
  pvc: "Persistent Volume",
  emptyDir: "Ephemeral (emptyDir)",
  configmap: "Config File",
}

function VolumeSection({ appId }: { appId: string }) {
  const [volumes, setVolumes] = useState<AppVolume[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  // Add form state
  const [addType, setAddType] = useState<VolumeType>("pvc")
  const [addMountPath, setAddMountPath] = useState("")
  const [addSize, setAddSize] = useState("")
  const [addContent, setAddContent] = useState("")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState("")
  const hasPvc = volumes.some((v) => v.type === "pvc")

  // Edit configmap state
  const [editId, setEditId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState("")
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState("")

  const loadVolumes = useCallback(async () => {
    try {
      const { items } = await api.volumes.list(appId)
      setVolumes(items)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [appId])

  useEffect(() => { loadVolumes() }, [loadVolumes])

  function resetForm() {
    setAddType("pvc"); setAddMountPath(""); setAddSize(""); setAddContent(""); setAddError("")
  }

  async function handleAdd() {
    setAddError("")
    setAdding(true)
    try {
      await api.volumes.create(appId, {
        type: addType,
        mountPath: addMountPath.trim(),
        config: addType === "pvc" ? { size: addSize.trim() }
          : addType === "emptyDir" ? (addSize.trim() ? { size: addSize.trim() } : {})
          : { content: addContent },
      })
      resetForm()
      setDialogOpen(false)
      await loadVolumes()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add volume")
    } finally { setAdding(false) }
  }

  async function handleDelete(id: string) {
    setDeleting(true); setDeleteError("")
    try {
      await api.volumes.delete(appId, id)
      setDeleteId(null)
      await loadVolumes()
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete volume")
    } finally { setDeleting(false) }
  }

  function openEdit(vol: AppVolume) {
    setEditId(vol.id)
    setEditContent(vol.config.content ?? "")
    setEditError("")
  }

  async function handleSaveEdit() {
    if (!editId) return
    setSaving(true); setEditError("")
    try {
      await api.volumes.update(appId, editId, { config: { content: editContent } })
      setEditId(null)
      await loadVolumes()
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : "Failed to save")
    } finally { setSaving(false) }
  }

  const volToDelete = volumes.find((v) => v.id === deleteId)
  const volToEdit = volumes.find((v) => v.id === editId)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Volume changes (add, edit, delete) take effect on the next deployment.
        Trigger a redeploy after changes to see them in your running app.
      </p>
      {hasPvc && (
        <div className="flex items-center gap-2 text-sm text-warning-text bg-warning-soft ring-1 ring-inset ring-warning-line rounded-md px-3 py-2">
          <TriangleAlert size={14} className="shrink-0" />
          <span>A PVC volume is attached. Replicas are locked to 1 (EBS volumes are ReadWriteOnce).</span>
        </div>
      )}

      {loading ? (
        <Skeleton className="h-4 w-40" />
      ) : volumes.length > 0 ? (
        <div className="flex flex-col divide-y divide-border border rounded-md">
          {volumes.map((vol) => (
            <div key={vol.id} className="flex items-center gap-3 px-4 py-3">
              {vol.type === "pvc" && <Folder size={14} className="text-muted-foreground shrink-0" />}
              {vol.type === "emptyDir" && <FolderX size={14} className="text-muted-foreground shrink-0" />}
              {vol.type === "configmap" && <FileText size={14} className="text-muted-foreground shrink-0" />}
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="text-sm font-mono">{vol.mountPath}</span>
                <Badge variant="outline" className="text-xs py-0 shrink-0">{VOLUME_TYPE_LABELS[vol.type]}</Badge>
                {vol.config.size && <span className="text-xs text-muted-foreground shrink-0">{vol.config.size}</span>}
              </div>
              {vol.type === "configmap" && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => openEdit(vol)}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => { setDeleteId(vol.id); setDeleteError("") }}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No volumes configured.</p>
      )}

      <div>
        <Button size="sm" variant="outline" onClick={() => { resetForm(); setDialogOpen(true) }}>Add volume</Button>
      </div>

      {/* Add volume dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add volume</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={addType} onValueChange={(v) => setAddType(v as VolumeType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pvc">Persistent Volume (PVC)</SelectItem>
                  <SelectItem value="emptyDir">Ephemeral (emptyDir)</SelectItem>
                  <SelectItem value="configmap">Config File (ConfigMap)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vol-path">Mount path</Label>
              <Input id="vol-path" placeholder="/data" value={addMountPath}
                onChange={(e) => setAddMountPath(e.target.value)}
                className="font-mono text-sm" />
            </div>
            {(addType === "pvc" || addType === "emptyDir") && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vol-size">
                  Size {addType === "emptyDir" && <span className="text-muted-foreground font-normal">(optional)</span>}
                </Label>
                <Input id="vol-size" placeholder={addType === "pvc" ? "5Gi" : "500Mi"} value={addSize}
                  onChange={(e) => setAddSize(e.target.value)}
                  className="font-mono text-sm w-36" />
                {addType === "pvc" && <p className="text-xs text-muted-foreground">Uses the cluster default storage class.</p>}
              </div>
            )}
            {addType === "configmap" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vol-content">File content</Label>
                <Textarea id="vol-content" value={addContent}
                  onChange={(e) => setAddContent(e.target.value)}
                  className="font-mono text-xs min-h-[120px]" spellCheck={false}
                  placeholder="# File content mounted at the path above" />
                <p className="text-xs text-muted-foreground">
                  Mounted as a single file at the path above using <code>subPath</code>.
                </p>
              </div>
            )}
            {addError && <p className="text-sm text-destructive">{addError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} disabled={adding ||
                !addMountPath.trim() ||
                (addType === "pvc" && !addSize.trim()) ||
                (addType === "configmap" && !addContent.trim())
              }>
                {adding ? "Adding…" : "Add volume"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit configmap dialog */}
      <Dialog open={!!editId} onOpenChange={(open) => { if (!open) setEditId(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit file content</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            {volToEdit && (
              <p className="text-xs text-muted-foreground font-mono">{volToEdit.mountPath}</p>
            )}
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="font-mono text-xs min-h-[200px]"
              spellCheck={false}
            />
            {editError && <p className="text-sm text-destructive">{editError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditId(null)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={handleSaveEdit} disabled={saving || !editContent.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete volume</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            {volToDelete?.type === "pvc" ? (
              <p className="text-sm text-destructive font-medium">
                This will permanently delete the underlying Kubernetes PersistentVolumeClaim and all data stored in it. This cannot be undone.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Remove the {volToDelete?.type === "configmap" ? "ConfigMap" : "emptyDir"} volume at{" "}
                <code className="text-xs font-mono">{volToDelete?.mountPath}</code> from this app?
              </p>
            )}
            {volToDelete?.type === "pvc" && (
              <p className="text-sm text-muted-foreground">
                Mount path: <code className="text-xs font-mono">{volToDelete.mountPath}</code>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Stop the app first if it&apos;s running with this mount — the next deploy
              will reconcile the change.
            </p>
            {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={deleting}
                onClick={() => deleteId && handleDelete(deleteId)}>
                {deleting ? "Deleting…" : volToDelete?.type === "pvc" ? "Delete PVC and data" : "Delete volume"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
                <TriangleAlert size={14} className="text-warning-text shrink-0" />
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
                    <TriangleAlert size={14} className="text-warning-text shrink-0" />
                    <p className="text-sm font-medium">Action required</p>
                  </div>
                  <p className="text-sm text-muted-foreground">Copy the URL and secret below and add them to your repository settings.</p>
                </div>
              )}
              {createResult.autoRegistered ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors self-start">
                      <ChevronDown size={13} className="transition-transform [[data-state=open]_&]:rotate-180" />
                      Show payload URL and secret
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="flex flex-col gap-4 pt-3">
                      <p className="text-xs text-muted-foreground">
                        You don&apos;t need these for anything right now — canette already registered the webhook in your repository.
                        Keep them if you want to verify the webhook in your provider&apos;s settings, or re-add it manually if it&apos;s ever removed there.
                      </p>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Payload URL</Label>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono break-all">{createResult.webhookUrl}</code>
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigator.clipboard.writeText(createResult.webhookUrl).catch(() => {})}>Copy</Button>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground flex items-center gap-1.5">Webhook secret <span className="text-warning-text font-medium">— copy now, shown once</span></Label>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 rounded-md border bg-warning-soft ring-1 ring-inset ring-warning-line border-transparent px-3 py-2 text-xs font-mono break-all">{createResult.webhookSecret}</code>
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => copySecret(createResult.webhookSecret)}>{secretCopied ? "Copied!" : "Copy"}</Button>
                        </div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Payload URL</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono break-all">{createResult.webhookUrl}</code>
                      <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigator.clipboard.writeText(createResult.webhookUrl).catch(() => {})}>Copy</Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">Webhook secret <span className="text-warning-text font-medium">— copy now, shown once</span></Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-md border bg-warning-soft ring-1 ring-inset ring-warning-line border-transparent px-3 py-2 text-xs font-mono break-all">{createResult.webhookSecret}</code>
                      <Button size="sm" variant="outline" className="shrink-0" onClick={() => copySecret(createResult.webhookSecret)}>{secretCopied ? "Copied!" : "Copy"}</Button>
                    </div>
                  </div>
                </>
              )}
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
  const { data: session } = useSession()
  const sessionUser = session?.user as Record<string, unknown> | undefined
  const isAdmin = (typeof sessionUser?.role === "string" ? sessionUser.role : undefined) === "admin"

  // General settings
  const [name, setName] = useState(app.name)
  const [sourceType, setSourceType] = useState<"git" | "image">(app.sourceType)
  const [deploymentType, setDeploymentType] = useState<"web" | "private" | "cronjob">(
    app.deploymentType ?? "web"
  )
  const [schedule, setSchedule] = useState(app.schedule ?? "")
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
    deploymentType !== (app.deploymentType ?? "web") ||
    schedule !== (app.schedule ?? "") ||
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
        deploymentType,
        schedule: deploymentType === "cronjob" ? schedule : null,
        gitUrl: sourceType === "git" ? gitUrl : undefined,
        gitBranch: sourceType === "git" ? gitBranch : undefined,
        appPath: sourceType === "git" ? appPath : undefined,
        imageUrl: sourceType === "image" ? imageUrl : undefined,
        imageTag: sourceType === "image" ? imageTag : undefined,
        port: deploymentType !== "cronjob" ? port : undefined,
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
    <div className="flex gap-6 items-start">
      <SectionNav showHostnames={isAdmin} showAccessControl={app.deploymentType === "web"} />
      <div className="flex-1 min-w-0 flex flex-col gap-6">
      {/* General */}
      <Section id="general" title="General">
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Source</Label>
            <SegmentedControl
              options={[{ value: "git", label: "Git" }, { value: "image", label: "Docker Image" }]}
              value={sourceType}
              onChange={setSourceType}
            />
          </div>

          <DeploymentTypeField
            value={app.deploymentType === "cronjob" ? "cronjob" : (deploymentType as "web" | "private")}
            onChange={setDeploymentType}
            options={
              app.deploymentType === "cronjob"
                ? [{ value: "cronjob", label: "Scheduled", disabled: true }]
                : [{ value: "web", label: "Public" }, { value: "private", label: "Private" }]
            }
            lockedNotice={app.deploymentType === "cronjob" ? "Deployment type cannot be changed after creation." : undefined}
          />

          {deploymentType === "cronjob" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule">Schedule</Label>
              <Input
                id="schedule"
                placeholder="0 2 * * *"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="font-mono w-48"
              />
              <p className="text-xs text-muted-foreground">Standard cron expression, e.g. <code>0 2 * * *</code> or <code>@daily</code>.</p>
            </div>
          )}

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
              <CredentialSelect credentials={credentials} value={gitCredentialId} onChange={setGitCredentialId} teamId={project.teamId} gitUrl={gitUrl} />
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

          {deploymentType !== "cronjob" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="port">Port</Label>
              <Input id="port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))}
                className="w-32 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
            </div>
          )}

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {savedMsg && <p className="text-sm text-warning-text">{savedMsg}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!isDirty || saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </div>
        </form>
      </Section>

      {/* Environment & Secrets */}
      <Section id="environment" title="Environment & Secrets" description="Variables are available in the runtime environment.">
        <EnvSection appId={app.id} />
      </Section>

      {/* Volumes */}
      <Section id="volumes" title="Volumes" description="Mount persistent storage, ephemeral scratch space, or configuration files into the container.">
        <VolumeSection appId={app.id} />
      </Section>

      {/* Custom domains (admin-only) */}
      {isAdmin && (
        <Section id="hostnames" title="Custom domains" description="Attach additional hostnames to this app's HTTPRoute, beyond the platform-generated URL.">
          <HostnameManager appId={app.id} />
        </Section>
      )}

      {/* Password protection */}
      {app.deploymentType === "web" && (
        <Section id="access" title="Password protection" description="Require a password before the public URL is reachable.">
          <PasswordGateManager appId={app.id} />
        </Section>
      )}

      {/* Webhooks */}
      <Section id="webhook" title="Webhook" description="Trigger deployments automatically on git push.">
        <WebhookSection appId={app.id} sourceType={app.sourceType} gitBranch={app.gitBranch || undefined}
          onWebhookChange={setHasWebhook} />
      </Section>

      {/* Advanced config */}
      <Section id="advanced" title="Advanced Configuration">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Inline <code className="text-xs">canette.yaml</code> configuration. Applied at deploy time as the base layer — if your repo contains a <code className="text-xs">canette.yaml</code>, its fields take precedence.
          </p>
          <Textarea className="font-mono text-xs min-h-[180px]" value={canetteConfigDraft}
            onChange={(e) => setCanetteConfigDraft(e.target.value)}
            placeholder={`resources:\n  requests:\n    cpu: "100m"\n    memory: "128Mi"\n  limits:\n    cpu: "500m"\n    memory: "512Mi"\nreplicas: 1`}
            spellCheck={false} />
          {configError && <p className="text-sm text-destructive">{configError}</p>}
          {configSaved && <p className="text-sm text-success-text">Saved.</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSaveConfig} disabled={savingConfig}>{savingConfig ? "Saving…" : "Save config"}</Button>
          </div>
        </div>
      </Section>

      {/* Danger zone */}
      <Collapsible id="danger" className="scroll-mt-6">
        <Card className="border-transparent ring-1 ring-inset ring-destructive-line">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none hover:bg-muted/30 transition-colors rounded-lg [&[data-state=open]]:rounded-b-none">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base text-destructive-text">Danger Zone</CardTitle>
                <ChevronDown size={15} className={cn("text-destructive-text/70 transition-transform [[data-state=open]_&]:rotate-180")} />
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
    </div>
  )
}
