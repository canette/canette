"use client"

import { useEffect, useState, useCallback, use } from "react"
import { useSearchParams } from "next/navigation"
import { SkeletonText } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { useSession } from "@/lib/auth-client"
import { Eye, EyeOff, Loader2, ChevronRight, GitBranch, Key } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"
import { GitLabIcon } from "@/components/icons/gitlab-icon"
import { GiteaIcon } from "@/components/icons/gitea-icon"
import * as api from "@/lib/api"
import type { GitCredential, GitCredentialType, GitProvider, Team } from "@canette/types"

const PROVIDERS: { value: GitProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitea", label: "Gitea" },
  { value: "generic", label: "Generic" },
]

const PROVIDER_ORDER: GitProvider[] = ["github", "gitlab", "gitea", "generic"]

function providerLabel(p: GitProvider): string {
  return PROVIDERS.find((x) => x.value === p)?.label ?? p
}

function typeLabel(t: GitCredentialType): string {
  if (t === "pat") return "PAT"
  if (t === "ssh_key") return "SSH Key"
  if (t === "github_app") return "GitHub App"
  return t
}

function suggestedName(provider: GitProvider, type: "pat" | "ssh_key"): string {
  return `${providerLabel(provider)} ${type === "pat" ? "PAT" : "SSH Key"}`
}

function patPlaceholder(provider: GitProvider): string {
  if (provider === "github") return "ghp_..."
  if (provider === "gitlab") return "glpat-..."
  return "paste token…"
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return "today"
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

export default function CredentialsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = use(params)
  const { data: session } = useSession()
  const searchParams = useSearchParams()

  const [team, setTeam] = useState<Team | null>(null)
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [loading, setLoading] = useState(true)

  // Delete confirm
  const [deleteCredConfirm, setDeleteCredConfirm] = useState<GitCredential | null>(null)
  const [deletingCred, setDeletingCred] = useState(false)
  const [deleteCredError, setDeleteCredError] = useState("")

  // Inline update form
  const [editingCredId, setEditingCredId] = useState<string | null>(null)
  const [editCredValue, setEditCredValue] = useState("")
  const [editCredShowValue, setEditCredShowValue] = useState(false)
  const [savingCred, setSavingCred] = useState(false)
  const [editCredError, setEditCredError] = useState("")

  // Add credential dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [dialogStep, setDialogStep] = useState<1 | 2 | 3>(1)
  const [dialogProvider, setDialogProvider] = useState<GitProvider | null>(null)
  const [dialogType, setDialogType] = useState<"pat" | "ssh_key" | "github_app" | null>(null)
  const [dialogName, setDialogName] = useState("")
  const [dialogValue, setDialogValue] = useState("")
  const [dialogShowValue, setDialogShowValue] = useState(false)
  const [dialogKnownHosts, setDialogKnownHosts] = useState("")
  const [dialogKnownHostsOpen, setDialogKnownHostsOpen] = useState(false)
  const [dialogSubmitting, setDialogSubmitting] = useState(false)
  const [dialogError, setDialogError] = useState("")

  // GitHub App
  const [connectingGithubApp, setConnectingGithubApp] = useState(false)
  const [githubAppNotice, setGithubAppNotice] = useState<string | null>(null)
  const [linkableInstallations, setLinkableInstallations] = useState<{ installationId: string; name: string }[]>([])
  const [linkingInstallationId, setLinkingInstallationId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [teamData, credData] = await Promise.all([
        api.teams.get(teamId),
        api.teams.listCredentials(teamId),
      ])
      setTeam(teamData)
      setCredentials(credData)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const status = searchParams.get("github_app")
    const error = searchParams.get("error")
    if (status === "installed") { setGithubAppNotice("GitHub App connected successfully."); load() }
    else if (status === "pending") setGithubAppNotice("GitHub App installation is pending admin approval on GitHub.")
    else if (error === "github-app-callback-failed") setGithubAppNotice("Failed to complete GitHub App installation. Please try again.")
  }, [searchParams, load])

  function resetDialog() {
    setDialogStep(1)
    setDialogProvider(null)
    setDialogType(null)
    setDialogName("")
    setDialogValue("")
    setDialogShowValue(false)
    setDialogKnownHosts("")
    setDialogKnownHostsOpen(false)
    setDialogError("")
    setLinkableInstallations([])
  }

  function handlePickProvider(provider: GitProvider) {
    setDialogProvider(provider)
    setDialogStep(2)
  }

  function handlePickType(type: "pat" | "ssh_key") {
    setDialogType(type)
    setDialogName(suggestedName(dialogProvider!, type))
    setDialogValue("")
    setDialogShowValue(false)
    setDialogKnownHosts("")
    setDialogKnownHostsOpen(false)
    setDialogError("")
    setDialogStep(3)
  }

  async function handlePickGithubApp() {
    setDialogType("github_app")
    setDialogError("")
    setDialogStep(3)
    setConnectingGithubApp(true)
    try {
      const { installations } = await api.githubApp.getLinkableInstallations(teamId)
      setLinkableInstallations(installations)
    } catch {
      setDialogError("Failed to load installations. Please try again.")
    } finally {
      setConnectingGithubApp(false)
    }
  }

  async function handleAddCred(e: React.FormEvent) {
    e.preventDefault()
    if (!dialogName.trim() || !dialogValue.trim() || !dialogProvider || !dialogType || dialogType === "github_app") return
    setDialogError("")
    setDialogSubmitting(true)
    try {
      const cred = await api.teams.createCredential(teamId, {
        name: dialogName.trim(),
        provider: dialogProvider,
        type: dialogType,
        value: dialogValue.trim(),
        sshKnownHosts: dialogType === "ssh_key" && dialogKnownHosts.trim() ? dialogKnownHosts.trim() : undefined,
      })
      setCredentials((prev) => [cred, ...prev])
      setAddDialogOpen(false)
    } catch (e: unknown) {
      setDialogError(e instanceof Error ? e.message : "Failed to add credential")
    } finally {
      setDialogSubmitting(false)
    }
  }

  async function handleUpdateCred(e: React.FormEvent, id: string) {
    e.preventDefault()
    if (!editCredValue.trim()) return
    setEditCredError("")
    setSavingCred(true)
    try {
      const updated = await api.teams.updateCredential(teamId, id, editCredValue.trim())
      setCredentials((prev) => prev.map((c) => c.id === id ? updated : c))
      setEditingCredId(null)
      setEditCredValue("")
    } catch (e: unknown) {
      setEditCredError(e instanceof Error ? e.message : "Failed to update credential")
    } finally {
      setSavingCred(false)
    }
  }

  async function handleDeleteCred() {
    if (!deleteCredConfirm) return
    setDeleteCredError("")
    setDeletingCred(true)
    try {
      await api.teams.deleteCredential(teamId, deleteCredConfirm.id)
      setCredentials((prev) => prev.filter((c) => c.id !== deleteCredConfirm.id))
      setDeleteCredConfirm(null)
    } catch (e: unknown) {
      setDeleteCredError(e instanceof Error ? e.message : "Failed to delete credential")
    } finally {
      setDeletingCred(false)
    }
  }

  async function handleConnectNewAccount() {
    setConnectingGithubApp(true)
    try {
      const result = await api.githubApp.getInstallUrl(teamId)
      if (!result.available || !result.url) {
        setDialogError("Per-Team GitHub App support is not configured on this instance. Ask your admin to set it up.")
        return
      }
      window.location.href = result.url
    } catch {
      setDialogError("Failed to get GitHub App install URL. Please try again.")
    } finally {
      setTimeout(() => setConnectingGithubApp(false), 2000)
    }
  }

  async function handleLinkInstallation(installationId: string) {
    setLinkingInstallationId(installationId)
    try {
      const cred = await api.githubApp.linkInstallation(teamId, installationId)
      setCredentials((prev) => [cred, ...prev])
      setLinkableInstallations((prev) => prev.filter((i) => i.installationId !== installationId))
      if (linkableInstallations.length <= 1) setAddDialogOpen(false)
      setGithubAppNotice("GitHub App installation linked to this team.")
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "Failed to link installation.")
    } finally {
      setLinkingInstallationId(null)
    }
  }

  if (loading) return <SkeletonText />
  if (!team) return <p className="text-muted-foreground text-sm">Team not found.</p>

  const systemGithubApp = credentials.find((c) => c.teamId === null && c.type === "github_app")
  const teamGithubAppCreds = credentials.filter((c) => c.teamId !== null && c.type === "github_app")
  const teamCreds = credentials.filter((c) => c.teamId !== null && c.type !== "github_app")

  const credsByProvider = new Map<GitProvider, GitCredential[]>()
  PROVIDER_ORDER.forEach((p) => credsByProvider.set(p, []))
  teamCreds.forEach((c) => credsByProvider.get(c.provider)?.push(c))

  function providerHasContent(p: GitProvider): boolean {
    const count = credsByProvider.get(p)?.length ?? 0
    if (p === "github") return count > 0 || !!systemGithubApp || teamGithubAppCreds.length > 0
    return count > 0
  }

  const activeProviders = PROVIDER_ORDER.filter(providerHasContent)

  return (
    <div className="flex flex-col gap-6">
      {githubAppNotice && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
          <p className="text-sm text-muted-foreground">{githubAppNotice}</p>
          <button type="button" onClick={() => setGithubAppNotice(null)}
            className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Dismiss">×</button>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Git Credentials</CardTitle>
            <CardDescription>
              Credentials for private repositories. Values are encrypted at rest and never visible once saved.
              {!team.isPersonal && <span><br />All team members can use these credentials when adding apps.</span>}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { resetDialog(); setAddDialogOpen(true) }} className="shrink-0 mt-1">
            <Key className="size-4" />
            Add credential
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {activeProviders.length === 0 && (
            <p className="text-muted-foreground text-sm px-6 py-8 text-center">
              No credentials yet.{" "}
              <button onClick={() => setAddDialogOpen(true)} className="underline hover:text-foreground transition-colors">Add one</button>
              {" "}to connect private repositories.
            </p>
          )}
          {activeProviders.map((provider, pi) => {
            const provCreds = credsByProvider.get(provider) ?? []
            const isGithub = provider === "github"
            return (
              <div key={provider}>
                {pi > 0 && <Separator />}
                <div className="px-6 py-1.5 bg-muted/20 border-b border-border/50">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {providerLabel(provider)}
                  </span>
                </div>
                {provCreds.map((cred, i) => (
                  <div key={cred.id}>
                    {i > 0 && <Separator />}
                    <div>
                      <div className="flex items-center gap-4 px-6 py-3 group">
                        <span className="text-sm font-medium flex-1 truncate">{cred.name}</span>
                        <Badge variant="secondary" className="text-xs font-normal shrink-0">{typeLabel(cred.type)}</Badge>
                        <span className="text-xs text-muted-foreground w-16 text-right shrink-0">{timeAgo(cred.createdAt)}</span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 shrink-0">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => { setEditingCredId(cred.id); setEditCredValue(""); setEditCredShowValue(false); setEditCredError("") }}>
                            Update
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => { setDeleteCredError(""); setDeleteCredConfirm(cred) }}>×</Button>
                        </div>
                      </div>
                      {editingCredId === cred.id && (
                        <form onSubmit={(e) => handleUpdateCred(e, cred.id)}
                          className="px-6 pb-4 flex flex-col gap-3 bg-muted/30 border-t border-border/50">
                          <p className="text-xs text-muted-foreground pt-3">
                            Enter a new {cred.type === "pat" ? "token" : "private key"} for{" "}
                            <span className="font-medium text-foreground">{cred.name}</span>
                          </p>
                          {cred.type === "ssh_key" ? (
                            <Textarea
                              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                              value={editCredValue} onChange={(e) => setEditCredValue(e.target.value)}
                              className="min-h-[140px] font-mono text-xs" spellCheck={false} autoComplete="off" autoFocus />
                          ) : (
                            <div className="flex items-center gap-2">
                              <Input type={editCredShowValue ? "text" : "password"} placeholder="paste new token…"
                                value={editCredValue} onChange={(e) => setEditCredValue(e.target.value)}
                                className="font-mono text-xs" autoFocus />
                              <button type="button" onClick={() => setEditCredShowValue((v) => !v)}
                                className="text-muted-foreground hover:text-foreground shrink-0" tabIndex={-1}>
                                {editCredShowValue ? <Eye size={15} /> : <EyeOff size={15} />}
                              </button>
                            </div>
                          )}
                          {editCredError && <p className="text-sm text-destructive">{editCredError}</p>}
                          <div className="flex items-center gap-2 justify-end">
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditingCredId(null)}>Cancel</Button>
                            <Button type="submit" size="sm" disabled={!editCredValue.trim() || savingCred}>
                              {savingCred ? "Saving…" : "Save"}
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                ))}
                {isGithub && (systemGithubApp || teamGithubAppCreds.length > 0) && (
                  <>
                    {provCreds.length > 0 && <Separator />}
                    {systemGithubApp && (
                      <>
                        <div className="flex items-center gap-4 px-6 py-3">
                          <span className="text-sm font-medium flex-1 truncate">{systemGithubApp.name}</span>
                          <Badge variant="secondary" className="text-xs font-normal">GitHub App</Badge>
                          <Badge variant="secondary" className="text-xs font-normal">configured by admin</Badge>
                          <span className="text-xs text-muted-foreground w-16 text-right">{timeAgo(systemGithubApp.createdAt)}</span>
                          <div className="w-[4.5rem]" />
                        </div>
                        {teamGithubAppCreds.length > 0 && <Separator />}
                      </>
                    )}
                    {teamGithubAppCreds.map((cred, i) => (
                      <div key={cred.id}>
                        {i > 0 && <Separator />}
                        <div className="flex items-center gap-4 px-6 py-3 group">
                          <span className="text-sm font-medium flex-1 truncate">{cred.name}</span>
                          <Badge variant="secondary" className="text-xs font-normal">GitHub App</Badge>
                          <span className="text-xs text-muted-foreground w-16 text-right">{timeAgo(cred.createdAt)}</span>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 shrink-0">
                            {cred.installationId && cred.connectedByUserId === session?.user?.id && (
                              <a href={`https://github.com/settings/installations/${cred.installationId}`}
                                target="_blank" rel="noopener noreferrer"
                                className="text-xs text-muted-foreground hover:text-foreground px-2">Configure ↗</a>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => { setDeleteCredError(""); setDeleteCredConfirm(cred) }}>×</Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Dialog open={deleteCredConfirm !== null} onOpenChange={(open) => { if (!open) setDeleteCredConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete credential</DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{deleteCredConfirm?.name}</strong>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteCredError && (
            <div className="flex items-center gap-2 rounded-md border border-input bg-muted px-3 py-2 mx-6 mb-2">
              <p className="text-sm text-destructive">{deleteCredError}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteCredConfirm(null)} disabled={deletingCred}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteCred} disabled={deletingCred}>
              {deletingCred ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add credential dialog */}
      <Dialog open={addDialogOpen} onOpenChange={(open) => { if (!open) { setAddDialogOpen(false); resetDialog() } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
            <DialogDescription>
              {dialogStep === 1 && "Choose a provider."}
              {dialogStep === 2 && `How do you want to connect to ${providerLabel(dialogProvider!)}?`}
              {dialogStep === 3 && dialogType === "github_app" && "Connect a GitHub account or organisation."}
              {dialogStep === 3 && dialogType !== "github_app" && `${providerLabel(dialogProvider!)} ${dialogType === "pat" ? "Personal Access Token" : "SSH Key"}`}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-6 flex flex-col gap-4">
            {dialogStep === 1 && (
              <div className="grid grid-cols-2 gap-3">
                {PROVIDERS.map((p) => (
                  <button key={p.value} type="button"
                    className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-medium hover:bg-muted/40 hover:border-foreground/30 transition-colors"
                    onClick={() => handlePickProvider(p.value)}>
                    {p.value === "github" && <GitHubIcon size={16} />}
                    {p.value === "gitlab" && <GitLabIcon size={16} />}
                    {p.value === "gitea" && <GiteaIcon size={16} />}
                    {p.value === "generic" && <GitBranch size={16} />}
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {dialogStep === 2 && dialogProvider && (
              <div className="flex flex-col gap-2">
                {dialogProvider === "github" && (
                  <button type="button"
                    className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 hover:bg-muted/40 hover:border-foreground/30 transition-colors text-left disabled:opacity-50"
                    onClick={handlePickGithubApp}
                    disabled={connectingGithubApp}>
                    <p className="text-sm font-medium flex items-center gap-2">
                      GitHub App
                      {connectingGithubApp && <Loader2 className="size-3 animate-spin" />}
                    </p>
                    <p className="text-xs text-muted-foreground">Connect via OAuth — select exactly which repos to grant access to</p>
                  </button>
                )}
                <button type="button"
                  className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 hover:bg-muted/40 hover:border-foreground/30 transition-colors text-left"
                  onClick={() => handlePickType("pat")}>
                  <p className="text-sm font-medium">Personal Access Token</p>
                  <p className="text-xs text-muted-foreground">Paste a token generated in your account settings</p>
                </button>
                <button type="button"
                  className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-3 hover:bg-muted/40 hover:border-foreground/30 transition-colors text-left"
                  onClick={() => handlePickType("ssh_key")}>
                  <p className="text-sm font-medium">SSH Key</p>
                  <p className="text-xs text-muted-foreground">Paste an SSH private key</p>
                </button>
                <Button type="button" variant="ghost" size="sm" className="self-start text-muted-foreground -ml-2 mt-1"
                  onClick={() => { setDialogStep(1); setDialogProvider(null) }}>
                  ← Back
                </Button>
              </div>
            )}

            {dialogStep === 3 && dialogType === "github_app" && (
              <div className="flex flex-col gap-3">
                {connectingGithubApp && <p className="text-sm text-muted-foreground">Loading…</p>}
                {!connectingGithubApp && (
                  <>
                    <p className="text-xs text-amber-600 dark:text-amber-500 border-l-2 border-amber-400 pl-2 leading-relaxed">
                      GitHub App permissions apply to all teams — you cannot restrict access per team. For fine-grained per-team access control, use fine-grained PAT tokens instead.
                    </p>
                    {linkableInstallations.length > 0 && (
                      <>
                        <p className="text-xs text-muted-foreground uppercase font-medium">Your installations</p>
                        {linkableInstallations.map((inst) => (
                          <div key={inst.installationId} className="flex items-center gap-3">
                            <span className="text-sm flex-1">{inst.name}</span>
                            <Button size="sm" variant="outline" onClick={() => handleLinkInstallation(inst.installationId)}
                              disabled={linkingInstallationId === inst.installationId}>
                              {linkingInstallationId === inst.installationId ? <Loader2 className="size-4 animate-spin" /> : "Link to this team"}
                            </Button>
                          </div>
                        ))}
                        <Separator />
                      </>
                    )}
                    <Button size="sm" variant={linkableInstallations.length > 0 ? "ghost" : "outline"}
                      className={linkableInstallations.length > 0 ? "self-start text-muted-foreground hover:text-foreground -ml-2" : "self-start"}
                      onClick={handleConnectNewAccount} disabled={connectingGithubApp}>
                      <GitHubIcon size={15} />
                      {linkableInstallations.length > 0 ? "Connect a different account or org" : "Connect GitHub Account or Org"}
                    </Button>
                  </>
                )}
                {dialogError && <p className="text-sm text-destructive">{dialogError}</p>}
                <Button type="button" variant="ghost" size="sm" className="self-start text-muted-foreground -ml-2 mt-1"
                  onClick={() => { setDialogStep(2); setDialogType(null); setLinkableInstallations([]); setDialogError("") }}>
                  ← Back
                </Button>
              </div>
            )}

            {dialogStep === 3 && dialogProvider && (dialogType === "pat" || dialogType === "ssh_key") && (
              <form onSubmit={handleAddCred} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="dialog-name">Name</Label>
                  <Input id="dialog-name" value={dialogName} onChange={(e) => setDialogName(e.target.value)} autoFocus />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="dialog-value">{dialogType === "pat" ? "Token" : "Private key"}</Label>
                  {dialogType === "ssh_key" ? (
                    <Textarea id="dialog-value"
                      className="min-h-[140px] font-mono text-xs"
                      placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                      value={dialogValue} onChange={(e) => setDialogValue(e.target.value)}
                      spellCheck={false} autoComplete="off" />
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input id="dialog-value" type={dialogShowValue ? "text" : "password"}
                        placeholder={patPlaceholder(dialogProvider)}
                        value={dialogValue} onChange={(e) => setDialogValue(e.target.value)}
                        className="font-mono text-xs" />
                      <button type="button" onClick={() => setDialogShowValue((v) => !v)}
                        className="text-muted-foreground hover:text-foreground shrink-0" tabIndex={-1}>
                        {dialogShowValue ? <Eye size={15} /> : <EyeOff size={15} />}
                      </button>
                    </div>
                  )}
                </div>
                {dialogType === "ssh_key" && (
                  <Collapsible open={dialogKnownHostsOpen} onOpenChange={setDialogKnownHostsOpen}>
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <ChevronRight size={12} className={`transition-transform duration-150 ${dialogKnownHostsOpen ? "rotate-90" : ""}`} />
                      Advanced
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 flex flex-col gap-1.5">
                      <Label htmlFor="dialog-known-hosts">
                        Known hosts <span className="ml-1 text-xs font-normal text-muted-foreground">optional</span>
                      </Label>
                      <Textarea id="dialog-known-hosts"
                        className="min-h-[80px] font-mono text-xs"
                        placeholder="github.com ssh-ed25519 AAAA..."
                        value={dialogKnownHosts} onChange={(e) => setDialogKnownHosts(e.target.value)} />
                    </CollapsibleContent>
                  </Collapsible>
                )}
                {dialogError && <p className="text-sm text-destructive">{dialogError}</p>}
                <div className="flex items-center justify-between">
                  <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2"
                    onClick={() => { setDialogStep(2); setDialogType(null); setDialogError("") }}>
                    ← Back
                  </Button>
                  <Button type="submit" size="sm" disabled={!dialogName.trim() || !dialogValue.trim() || dialogSubmitting}>
                    {dialogSubmitting ? "Adding…" : "Add credential"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
