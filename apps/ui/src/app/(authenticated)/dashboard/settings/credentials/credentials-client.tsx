"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { Eye, EyeOff } from "lucide-react"
import * as api from "@/lib/api"
import type { GitCredential, GitProvider, GitCredentialType } from "@canette/types"

const PROVIDERS: { value: GitProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitea", label: "Gitea" },
  { value: "generic", label: "Generic" },
]

function providerLabel(p: GitProvider) {
  return PROVIDERS.find((x) => x.value === p)?.label ?? p
}

function typeLabel(t: GitCredentialType) {
  if (t === "pat") return "PAT"
  if (t === "ssh_key") return "SSH Key"
  if (t === "github_app") return "GitHub App"
  return t
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return "today"
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

export function CredentialsClient() {
  const [items, setItems] = useState<GitCredential[]>([])
  const [loading, setLoading] = useState(true)

  // add form state
  const [name, setName] = useState("")
  const [provider, setProvider] = useState<GitProvider>("github")
  const [type, setType] = useState<GitCredentialType>("pat")
  const [value, setValue] = useState("")
  const [showValue, setShowValue] = useState(false)
  const [knownHosts, setKnownHosts] = useState("")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState("")

  // edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [editShowValue, setEditShowValue] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState("")

  async function load() {
    try {
      const data = await api.credentials.list()
      setItems(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !value.trim()) return
    setAddError("")
    setAdding(true)
    try {
      await api.credentials.create({
        name: name.trim(),
        provider,
        type,
        value: value.trim(),
        sshKnownHosts: type === "ssh_key" && knownHosts.trim() ? knownHosts.trim() : undefined,
      })
      setName("")
      setValue("")
      setKnownHosts("")
      setShowValue(false)
      await load()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add credential")
    } finally {
      setAdding(false)
    }
  }

  function startEdit(cred: GitCredential) {
    setEditingId(cred.id)
    setEditValue("")
    setEditShowValue(false)
    setEditError("")
  }

  function cancelEdit() {
    setEditingId(null)
    setEditValue("")
    setEditError("")
  }

  async function handleUpdate(e: React.FormEvent, id: string) {
    e.preventDefault()
    if (!editValue.trim()) return
    setEditError("")
    setSaving(true)
    try {
      const updated = await api.credentials.update(id, editValue.trim())
      setItems((prev) => prev.map((c) => c.id === id ? updated : c))
      cancelEdit()
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : "Failed to update credential")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.credentials.delete(id)
      setItems((prev) => prev.filter((c) => c.id !== id))
    } catch {
      // ignore
    }
  }

  const addButtonDisabled = !name.trim() || !value.trim() || adding

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Git Credentials</h1>
      </div>

      <Card>
          <CardHeader>
            <CardTitle className="text-base">Credentials</CardTitle>
            <CardDescription>
              Saved credentials for private repositories. Values are encrypted at rest and never returned by the API.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <p className="text-muted-foreground text-sm px-6 pb-4">Loading…</p>
            ) : (
              <>
                {items.length > 0 && (
                  <>
                    <div className="px-6 py-1.5 flex items-center gap-4 border-b border-border/50">
                      <span className="text-xs text-muted-foreground w-48">NAME</span>
                      <span className="text-xs text-muted-foreground w-20">PROVIDER</span>
                      <span className="text-xs text-muted-foreground w-24">TYPE</span>
                      <span className="text-xs text-muted-foreground">ADDED</span>
                    </div>
                    {items.map((cred, i) => (
                      <div key={cred.id}>
                        {i > 0 && <Separator />}
                        <div className="flex items-center gap-4 px-6 py-3 group">
                          <span className="text-sm font-medium w-48 truncate">{cred.name}</span>
                          <span className="text-xs text-muted-foreground w-20">{providerLabel(cred.provider)}</span>
                          <span className="text-xs text-muted-foreground w-24">{typeLabel(cred.type)}</span>
                          <span className="text-xs text-muted-foreground flex-1">{timeAgo(cred.createdAt)}</span>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                            {cred.type !== "github_app" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => startEdit(cred)}
                                >
                                  Update
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                  onClick={() => handleDelete(cred.id)}
                                >
                                  ×
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {editingId === cred.id && (
                          <form
                            onSubmit={(e) => handleUpdate(e, cred.id)}
                            className="px-6 pb-4 flex flex-col gap-3 bg-muted/30 border-t border-border/50"
                          >
                            <p className="text-xs text-muted-foreground pt-3">
                              Enter a new {cred.type === "pat" ? "token" : "private key"} for <span className="font-medium text-foreground">{cred.name}</span>
                            </p>
                            {cred.type === "ssh_key" ? (
                              <textarea
                                className="min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                                placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                spellCheck={false}
                                autoComplete="off"
                                autoFocus
                              />
                            ) : (
                              <div className="flex items-center gap-2">
                                <Input
                                  type={editShowValue ? "text" : "password"}
                                  placeholder="ghp_..."
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="font-mono text-xs"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => setEditShowValue((v) => !v)}
                                  className="text-muted-foreground hover:text-foreground shrink-0"
                                  tabIndex={-1}
                                >
                                  {editShowValue ? <Eye size={15} /> : <EyeOff size={15} />}
                                </button>
                              </div>
                            )}
                            {editError && <p className="text-sm text-destructive">{editError}</p>}
                            <div className="flex items-center gap-2 justify-end">
                              <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>Cancel</Button>
                              <Button type="submit" size="sm" disabled={!editValue.trim() || saving}>
                                {saving ? "Saving…" : "Save"}
                              </Button>
                            </div>
                          </form>
                        )}
                      </div>
                    ))}
                    <Separator />
                  </>
                )}

                {items.length === 0 && !loading && (
                  <p className="text-muted-foreground text-sm px-6 py-8 text-center">No credentials yet.</p>
                )}

                {/* Add form */}
                <form onSubmit={handleAdd} className="px-6 py-4 flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cred-name">Name</Label>
                      <Input
                        id="cred-name"
                        placeholder="e.g. GitHub (work)"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Provider</Label>
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={provider}
                        onChange={(e) => setProvider(e.target.value as GitProvider)}
                      >
                        {PROVIDERS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Type</Label>
                    <div className="flex rounded-md border border-border overflow-hidden w-fit">
                      <button
                        type="button"
                        onClick={() => { setType("pat"); setValue("") }}
                        className={cn(
                          "px-4 py-1.5 text-sm transition-colors",
                          type === "pat"
                            ? "bg-foreground text-background font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        PAT
                      </button>
                      <button
                        type="button"
                        onClick={() => { setType("ssh_key"); setValue(""); setShowValue(false) }}
                        className={cn(
                          "px-4 py-1.5 text-sm transition-colors border-l border-border",
                          type === "ssh_key"
                            ? "bg-foreground text-background font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        SSH Key
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cred-value">
                        {type === "pat" ? "Token" : "Private key"}
                      </Label>
                      {type === "ssh_key" ? (
                        <textarea
                          id="cred-value"
                          className="min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <Input
                            id="cred-value"
                            type={showValue ? "text" : "password"}
                            placeholder="ghp_..."
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            className="font-mono text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => setShowValue((v) => !v)}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                            tabIndex={-1}
                            aria-label={showValue ? "Hide value" : "Show value"}
                          >
                            {showValue ? <Eye size={15} /> : <EyeOff size={15} />}
                          </button>
                        </div>
                      )}
                    </div>

                  {type === "ssh_key" && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cred-known-hosts">
                        Known hosts
                        <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                      </Label>
                      <textarea
                        id="cred-known-hosts"
                        className="min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                        placeholder="github.com ssh-ed25519 AAAA..."
                        value={knownHosts}
                        onChange={(e) => setKnownHosts(e.target.value)}
                      />
                    </div>
                  )}

                  {addError && <p className="text-sm text-destructive">{addError}</p>}

                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={addButtonDisabled}>
                      {adding ? "Adding…" : "Add credential"}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </CardContent>
      </Card>
    </div>
  )
}
