"use client"

import { useEffect, useState, useCallback, use } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { AppShell } from "@/components/app-shell"
import { useSession } from "@/lib/auth-client"
import { cn } from "@/lib/utils"
import { ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"
import * as api from "@/lib/api"
import type { GitCredential, GitCredentialType, GitProvider, Team, TeamMember } from "@canette/types"

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

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = use(params)
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === "admin"
  const searchParams = useSearchParams()

  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [loading, setLoading] = useState(true)

  // Credentials
  const [credName, setCredName] = useState("")
  const [credProvider, setCredProvider] = useState<GitProvider>("github")
  const [credType, setCredType] = useState<GitCredentialType>("pat")
  const [credValue, setCredValue] = useState("")
  const [credShowValue, setCredShowValue] = useState(false)
  const [credKnownHosts, setCredKnownHosts] = useState("")
  const [addingCred, setAddingCred] = useState(false)
  const [credError, setCredError] = useState("")

  // Edit credential
  const [editingCredId, setEditingCredId] = useState<string | null>(null)
  const [editCredValue, setEditCredValue] = useState("")
  const [editCredShowValue, setEditCredShowValue] = useState(false)
  const [savingCred, setSavingCred] = useState(false)
  const [editCredError, setEditCredError] = useState("")

  // GitHub App installation
  const [connectingGithubApp, setConnectingGithubApp] = useState(false)
  const [githubAppNotice, setGithubAppNotice] = useState<string | null>(null)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkableInstallations, setLinkableInstallations] = useState<{ installationId: string; name: string }[]>([])
  const [linkingInstallationId, setLinkingInstallationId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [teamData, credData] = await Promise.all([
        api.teams.get(teamId),
        api.teams.listCredentials(teamId),
      ])
      setTeam(teamData)
      setMembers(teamData.members)
      setCredentials(credData)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  // Handle redirect back from GitHub App installation flow.
  useEffect(() => {
    const status = searchParams.get("github_app")
    const error = searchParams.get("error")
    if (status === "installed") {
      setGithubAppNotice("GitHub App connected successfully.")
      load()
    } else if (status === "pending") {
      setGithubAppNotice("GitHub App installation is pending admin approval on GitHub.")
    } else if (error === "github-app-callback-failed") {
      setGithubAppNotice("Failed to complete GitHub App installation. Please try again.")
    }
  }, [searchParams, load])

  async function handleAddCred(e: React.FormEvent) {
    e.preventDefault()
    if (!credName.trim() || !credValue.trim()) return
    setCredError("")
    setAddingCred(true)
    try {
      const cred = await api.teams.createCredential(teamId, {
        name: credName.trim(),
        provider: credProvider,
        type: credType,
        value: credValue.trim(),
        sshKnownHosts: credType === "ssh_key" && credKnownHosts.trim() ? credKnownHosts.trim() : undefined,
      })
      setCredentials((prev) => [cred, ...prev])
      setCredName("")
      setCredValue("")
      setCredKnownHosts("")
      setCredShowValue(false)
    } catch (e: unknown) {
      setCredError(e instanceof Error ? e.message : "Failed to add credential")
    } finally {
      setAddingCred(false)
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

  async function handleDeleteCred(id: string) {
    try {
      await api.teams.deleteCredential(teamId, id)
      setCredentials((prev) => prev.filter((c) => c.id !== id))
    } catch (e: unknown) {
      // Show error inline if deletion is blocked
      alert(e instanceof Error ? e.message : "Failed to delete credential")
    }
  }

  async function handleConnectGithubApp() {
    setConnectingGithubApp(true)
    try {
      const { installations } = await api.githubApp.getLinkableInstallations(teamId)
      if (installations.length > 0) {
        setLinkableInstallations(installations)
        setLinkDialogOpen(true)
        return
      }
      const result = await api.githubApp.getInstallUrl(teamId)
      if (!result.available || !result.url) {
        setGithubAppNotice("Per-Team GitHub App support is not configured on this instance. Ask your admin to set it up.")
        return
      }
      window.location.href = result.url
    } catch {
      setGithubAppNotice("Failed to get GitHub App install URL. Please try again.")
    } finally {
      setConnectingGithubApp(false)
    }
  }

  async function handleConnectNewAccount() {
    setLinkDialogOpen(false)
    setConnectingGithubApp(true)
    try {
      const result = await api.githubApp.getInstallUrl(teamId)
      if (!result.available || !result.url) {
        setGithubAppNotice("Per-Team GitHub App support is not configured on this instance. Ask your admin to set it up.")
        return
      }
      window.location.href = result.url
    } catch {
      setGithubAppNotice("Failed to get GitHub App install URL. Please try again.")
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
      if (linkableInstallations.length <= 1) setLinkDialogOpen(false)
      setGithubAppNotice("GitHub App installation linked to this team.")
    } catch (e) {
      setGithubAppNotice(e instanceof Error ? e.message : "Failed to link installation.")
    } finally {
      setLinkingInstallationId(null)
    }
  }

  if (loading) {
    return (
      <AppShell breadcrumb={[{ label: "canette", href: "/dashboard" }, { label: "Teams", href: "/dashboard/teams" }, { label: "…" }]}>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </AppShell>
    )
  }

  if (!team) {
    return (
      <AppShell breadcrumb={[{ label: "canette", href: "/dashboard" }, { label: "Teams", href: "/dashboard/teams" }, { label: "Not found" }]}>
        <p className="text-muted-foreground text-sm">Team not found.</p>
      </AppShell>
    )
  }

  const systemGithubApp = credentials.find((c) => c.teamId === null && c.type === "github_app")
  const teamGithubAppCreds = credentials.filter((c) => c.teamId !== null && c.type === "github_app")
  const teamCreds = credentials.filter((c) => c.teamId !== null && c.type !== "github_app")

  return (
    <AppShell
      breadcrumb={[
        { label: "canette", href: "/dashboard" },
        { label: "Teams", href: "/dashboard/teams" },
        { label: team.name },
      ]}
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-start gap-3">
          <Link href="/dashboard/teams" className="text-muted-foreground hover:text-foreground transition-colors mt-1">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-semibold">{team.name}</h1>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6">

        {/* Members */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Members
              {team.isPersonal && (
                <Badge variant="secondary" className="text-xs font-normal">personal team</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {team.isPersonal
                ? "Your personal team - for your personal projects. You are the only member."
                : "All members have full access to this team's projects and apps."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!team.isPersonal && members.length > 0 && (
              <>
                <div className="px-6 py-1.5 flex items-center gap-4 border-b border-border/50">
                  <span className="text-xs text-muted-foreground uppercase flex-1">Name / Email</span>
                  <span className="text-xs text-muted-foreground uppercase text-right w-20">Joined</span>
                </div>
                {members.map((member, i) => (
                  <div key={member.userId}>
                    {i > 0 && <Separator />}
                    <div className="flex items-center gap-4 px-6 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{member.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                      </div>
                      <span className="text-xs text-muted-foreground text-right w-20">{timeAgo(member.joinedAt)}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {!team.isPersonal && isAdmin && (
              <p className="text-xs text-muted-foreground px-6 py-3 border-t border-border/50">
                Manage members in <a href="/admin" className="underline hover:text-foreground">Admin → Teams</a>.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Team Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Git Credentials</CardTitle>
            <CardDescription>
              Credentials for private repositories. Values are encrypted at rest and never visible once saved.
              {!team.isPersonal ? <span><br/>All team members can use these credentials when adding Applications.</span> : "" }
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {teamCreds.length > 0 && (
              <>
                <div className="px-6 py-1.5 flex items-center gap-4 border-b border-border/50">
                  <span className="text-xs text-muted-foreground uppercase w-48">Name</span>
                  <span className="text-xs text-muted-foreground uppercase w-20">Provider</span>
                  <span className="text-xs text-muted-foreground uppercase w-24">Type</span>
                  <span className="text-xs text-muted-foreground uppercase flex-1">Added</span>
                </div>
                {teamCreds.map((cred, i) => (
                  <div key={cred.id}>
                    {i > 0 && <Separator />}
                    <div className="flex items-center gap-4 px-6 py-3 group">
                      <span className="text-sm font-medium w-48 truncate">{cred.name}</span>
                      <span className="text-xs text-muted-foreground w-20">{providerLabel(cred.provider)}</span>
                      <span className="text-xs text-muted-foreground w-24">{typeLabel(cred.type)}</span>
                      <span className="text-xs text-muted-foreground flex-1">{timeAgo(cred.createdAt)}</span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => { setEditingCredId(cred.id); setEditCredValue(""); setEditCredShowValue(false); setEditCredError("") }}
                        >
                          Update
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteCred(cred.id)}
                        >
                          ×
                        </Button>
                      </div>
                    </div>
                    {editingCredId === cred.id && (
                      <form
                        onSubmit={(e) => handleUpdateCred(e, cred.id)}
                        className="px-6 pb-4 flex flex-col gap-3 bg-muted/30 border-t border-border/50"
                      >
                        <p className="text-xs text-muted-foreground pt-3">
                          Enter a new {cred.type === "pat" ? "token" : "private key"} for <span className="font-medium text-foreground">{cred.name}</span>
                        </p>
                        {cred.type === "ssh_key" ? (
                          <textarea
                            className="min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                            value={editCredValue}
                            onChange={(e) => setEditCredValue(e.target.value)}
                            spellCheck={false}
                            autoComplete="off"
                            autoFocus
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              type={editCredShowValue ? "text" : "password"}
                              placeholder="ghp_..."
                              value={editCredValue}
                              onChange={(e) => setEditCredValue(e.target.value)}
                              className="font-mono text-xs"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => setEditCredShowValue((v) => !v)}
                              className="text-muted-foreground hover:text-foreground shrink-0"
                              tabIndex={-1}
                            >
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
                ))}
                <Separator />
              </>
            )}

            {teamCreds.length === 0 && (
              <p className="text-muted-foreground text-sm px-6 py-4 text-center">No credentials yet.</p>
            )}

            {/* Add credential form */}
            <form onSubmit={handleAddCred} className="px-6 py-4 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cred-name">Name</Label>
                  <Input
                    id="cred-name"
                    placeholder="e.g. GitHub (work)"
                    value={credName}
                    onChange={(e) => setCredName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Provider</Label>
                  <Select value={credProvider} onValueChange={(v) => setCredProvider(v as GitProvider)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Type</Label>
                <div className="flex rounded-md border border-border overflow-hidden w-fit">
                  <button
                    type="button"
                    onClick={() => { setCredType("pat"); setCredValue("") }}
                    className={cn(
                      "px-4 py-1.5 text-sm transition-colors",
                      credType === "pat"
                        ? "bg-foreground text-background font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    PAT
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCredType("ssh_key"); setCredValue(""); setCredShowValue(false) }}
                    className={cn(
                      "px-4 py-1.5 text-sm transition-colors border-l border-border",
                      credType === "ssh_key"
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
                  {credType === "pat" ? "Token" : "Private key"}
                </Label>
                {credType === "ssh_key" ? (
                  <textarea
                    id="cred-value"
                    className="min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                    placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                    value={credValue}
                    onChange={(e) => setCredValue(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      id="cred-value"
                      type={credShowValue ? "text" : "password"}
                      placeholder="ghp_..."
                      value={credValue}
                      onChange={(e) => setCredValue(e.target.value)}
                      className="font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setCredShowValue((v) => !v)}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      tabIndex={-1}
                      aria-label={credShowValue ? "Hide value" : "Show value"}
                    >
                      {credShowValue ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                  </div>
                )}
              </div>

              {credType === "ssh_key" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cred-known-hosts">
                    Known hosts
                    <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                  </Label>
                  <textarea
                    id="cred-known-hosts"
                    className="min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-y"
                    placeholder="github.com ssh-ed25519 AAAA..."
                    value={credKnownHosts}
                    onChange={(e) => setCredKnownHosts(e.target.value)}
                  />
                </div>
              )}

              {credError && <p className="text-sm text-destructive">{credError}</p>}

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={!credName.trim() || !credValue.trim() || addingCred}>
                  {addingCred ? "Adding…" : "Add credential"}
                </Button>
              </div>
            </form>

          </CardContent>
        </Card>

        {/* GitHub App */}
        {(systemGithubApp || teamGithubAppCreds.length > 0 || true) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">GitHub App</CardTitle>
              <CardDescription>
                Connect your GitHub account or org to grant canette access to repositories.
                {!team.isPersonal && <span><br/>All team members can use the connected credentials when adding Applications.</span>}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {githubAppNotice && (
                <div className="px-6 py-3 bg-muted/40 border-b border-border/50 flex items-center justify-between gap-4">
                  <p className="text-sm text-muted-foreground">{githubAppNotice}</p>
                  <button
                    type="button"
                    onClick={() => setGithubAppNotice(null)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              )}

              {systemGithubApp && (
                <>
                  <div className="px-6 py-3 border-b border-border/50">
                    <p className="text-xs text-muted-foreground uppercase font-medium mb-2">System installation</p>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-medium flex-1">{systemGithubApp.name}</span>
                      <Badge variant="secondary" className="text-xs">configured by admin</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Available to all teams. Access is configured by your instance admin.</p>
                  </div>
                </>
              )}

              {teamGithubAppCreds.length > 0 && (
                <>
                  <div className="px-6 py-1.5 flex items-center gap-4 border-b border-border/50">
                    <span className="text-xs text-muted-foreground uppercase flex-1">Team installations</span>
                    <span className="w-20" />
                    <span className="text-xs text-muted-foreground uppercase w-20 text-right">Connected</span>
                    <span className="w-7" />
                  </div>
                  {teamGithubAppCreds.map((cred, i) => (
                    <div key={cred.id}>
                      {i > 0 && <Separator />}
                      <div className="flex items-center gap-4 px-6 py-3 group">
                        <span className="text-sm font-medium flex-1 truncate">{cred.name}</span>
                        {cred.installationId && cred.connectedByUserId === session?.user?.id ? (
                          <a
                            href={`https://github.com/settings/installations/${cred.installationId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-foreground w-20 text-right opacity-0 group-hover:opacity-100"
                            title="Configure repo access on GitHub"
                          >
                            Configure ↗
                          </a>
                        ) : (
                          <span className="w-20" />
                        )}
                        <span className="text-xs text-muted-foreground w-20 text-right">{timeAgo(cred.createdAt)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                          onClick={() => handleDeleteCred(cred.id)}
                          title="Remove installation"
                        >
                          ×
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Separator />
                </>
              )}

              <div className="px-6 py-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConnectGithubApp}
                  disabled={connectingGithubApp}
                >
                  {connectingGithubApp ? <Loader2 className="size-4 animate-spin" /> : <GitHubIcon size={18} />}
                  Connect GitHub Account or Org
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      </div>

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect GitHub App</DialogTitle>
            <DialogDescription>
              Link your existing Github App to this team or connect a new GitHub account or org.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-2 flex flex-col gap-2">
            <p className="text-xs text-amber-600 dark:text-amber-500 border-l-2 border-amber-400 pl-2 leading-relaxed mb-2">
              GitHub App permissions apply to all teams — you cannot restrict access per team. For fine-grained per-team access control, use fine-grained PAT tokens instead.
            </p>
            <p className="text-xs text-muted-foreground uppercase font-medium">Your installations</p>
            {linkableInstallations.map((inst) => (
              <div key={inst.installationId} className="flex items-center gap-3 py-1">
                <span className="text-sm flex-1">{inst.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleLinkInstallation(inst.installationId)}
                  disabled={linkingInstallationId === inst.installationId}
                >
                  {linkingInstallationId === inst.installationId
                    ? <Loader2 className="size-4 animate-spin" />
                    : "Link to this team"}
                </Button>
              </div>
            ))}
          </div>
          <div className="px-6 pb-6 pt-2 border-t border-border/50 mt-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleConnectNewAccount}
            >
              <GitHubIcon size={15} />
              Connect a different account or org
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </AppShell>
  )
}
