"use client"

import { useState, useEffect, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { HelpTooltip } from "@/components/ui/tooltip"
import { CanetteLogo } from "@/components/canette-logo"
import { CredentialSelect } from "@/components/credential-select"
import * as api from "@/lib/api"
import type { GitCredential, Project } from "@canette/types"

function parseGitUrl(raw: string): { gitUrl: string; branch: string; appPath: string } | null {
  // GitHub: https://github.com/org/repo/tree/branch[/path]
  const gh = raw.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)(\/.*)?$/)
  if (gh) return { gitUrl: gh[1], branch: gh[2], appPath: gh[3] ?? "" }
  // GitLab: https://gitlab.com/org/repo/-/tree/branch[/path]
  const gl = raw.match(/^(https:\/\/gitlab\.com\/[^/]+\/[^/]+)\/-\/tree\/([^/]+)(\/.*)?$/)
  if (gl) return { gitUrl: gl[1], branch: gl[2], appPath: gl[3] ?? "" }
  return null
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

type SlugState = "idle" | "checking" | "available" | "taken" | "invalid"

export default function NewAppPage() {
  const { slug: projectSlug } = useParams<{ slug: string }>()
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugState, setSlugState] = useState<SlugState>("idle")
  const [sourceType, setSourceType] = useState<"git" | "image">("git")
  const [gitUrl, setGitUrl] = useState("")
  const [gitBranch, setGitBranch] = useState("main")
  const [appPath, setAppPath] = useState("")
  const [urlParsed, setUrlParsed] = useState(false)
  const [imageUrl, setImageUrl] = useState("")
  const [imageTag, setImageTag] = useState("latest")
  const [port, setPort] = useState(3000)
  const [gitCredentialId, setGitCredentialId] = useState<string>("")
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.projects.get(projectSlug)
      .then(setProject)
      .catch(() => setError("Failed to load project"))
    api.projects.listCredentials(projectSlug).then(setCredentials).catch(() => {})
  }, [projectSlug])

  useEffect(() => {
    if (!slugEdited) setSlug(toSlug(name))
  }, [name, slugEdited])

  useEffect(() => {
    if (!project) return
    if (checkTimer.current) clearTimeout(checkTimer.current)
    if (!slug) { setSlugState("idle"); return }

    const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !slug.endsWith("-")
    if (!valid) { setSlugState("invalid"); return }

    setSlugState("checking")
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/v1/projects/${project.id}/apps/slug-available?slug=${encodeURIComponent(slug)}`,
          { credentials: "include" },
        )
        const data = await res.json()
        setSlugState(data.available ? "available" : "taken")
      } catch {
        setSlugState("idle")
      }
    }, 400)

    return () => { if (checkTimer.current) clearTimeout(checkTimer.current) }
  }, [slug, project])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!project || slugState !== "available") return
    setError("")
    setSubmitting(true)

    try {
      const body =
        sourceType === "git"
          ? {
              name: name.trim(),
              slug,
              sourceType,
              gitUrl: gitUrl.trim(),
              gitBranch: gitBranch.trim() || "main",
              appPath: appPath.trim() || undefined,
              gitCredentialId: gitCredentialId || undefined,
              port,
            }
          : {
              name: name.trim(),
              slug,
              sourceType,
              imageUrl: imageUrl.trim(),
              imageTag: imageTag.trim() || "latest",
              port,
            }

      const res = await fetch(`/api/v1/projects/${project.id}/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Something went wrong"); return }
      router.push(`/dashboard/projects/${projectSlug}/apps/${data.slug}`)
    } catch {
      setError("Network error — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  const slugHint = {
    idle: null,
    checking: <span className="text-muted-foreground">Checking…</span>,
    available: <span className="text-green-500">Available</span>,
    taken: <span className="text-destructive">Already taken in this project</span>,
    invalid: <span className="text-destructive">Lowercase letters, numbers and hyphens only; cannot start or end with a hyphen</span>,
  }[slugState]

  const sourceReady =
    sourceType === "git" ? !!gitUrl.trim() : !!imageUrl.trim()

  const canSubmit = !!name.trim() && sourceReady && slugState === "available" && !!project && !submitting

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-3 text-sm">
          <a href="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors font-semibold">
              <CanetteLogo className="size-5 p-0.5" />
              canette
            </a>
          <span className="text-muted-foreground/40">/</span>
          <a href={`/dashboard/projects/${projectSlug}`} className="text-muted-foreground hover:text-foreground transition-colors">
            {project?.name ?? projectSlug}
          </a>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-medium">Add app</span>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Add app</CardTitle>
            <CardDescription>Connect a Git repository or Docker image to deploy.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="My App"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="slug">
                  Slug
                  <span className="ml-2 text-xs text-muted-foreground font-normal">(used as container name)</span>
                </Label>
                <Input
                  id="slug"
                  placeholder="my-app"
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }}
                  className={cn(
                    slugState === "taken" || slugState === "invalid" ? "border-destructive" : "",
                    slugState === "available" ? "border-green-500" : "",
                  )}
                />
                <p className="text-xs min-h-[1rem]">{slugHint}</p>
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
                    <Input
                      id="gitUrl"
                      placeholder="https://github.com/org/repo"
                      value={gitUrl}
                      onChange={(e) => {
                        const parsed = parseGitUrl(e.target.value)
                        if (parsed) {
                          setGitUrl(parsed.gitUrl)
                          setGitBranch(parsed.branch)
                          setAppPath(parsed.appPath)
                          setUrlParsed(true)
                        } else {
                          setGitUrl(e.target.value)
                          setUrlParsed(false)
                        }
                      }}
                      required
                    />
                    {urlParsed && (
                      <p className="text-xs text-muted-foreground">
                        Branch and app path were detected from the URL.
                      </p>
                    )}
                  </div>

                  {credentials.length > 0 && (
                    <CredentialSelect
                      credentials={credentials}
                      value={gitCredentialId}
                      onChange={setGitCredentialId}
                    />
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="gitBranch">Branch</Label>
                      <Input
                        id="gitBranch"
                        placeholder="main"
                        value={gitBranch}
                        onChange={(e) => setGitBranch(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="appPath">
                        App path
                        <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                      </Label>
                      <Input
                        id="appPath"
                        placeholder="/"
                        value={appPath}
                        onChange={(e) => setAppPath(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="imageUrl">Image</Label>
                    <Input
                      id="imageUrl"
                      placeholder="nginx"
                      value={imageUrl}
                      onChange={(e) => setImageUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="imageTag">Tag</Label>
                    <Input
                      id="imageTag"
                      placeholder="latest"
                      value={imageTag}
                      onChange={(e) => setImageTag(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="port" className="flex items-center gap-1">
                  Port
                  <HelpTooltip>
                    <p className="mb-1.5">The same port your app uses locally, e.g. <code className="font-mono">http://localhost:3000</code> → port 3000.</p>
                    <p className="mb-1 font-medium">Common defaults:</p>
                    <ul className="space-y-0.5 text-muted-foreground">
                      <li>Next.js / Node / Rails → 3000</li>
                      <li>Vite → 5173</li>
                      <li>Django / Laravel → 8000</li>
                      <li>Flask / FastAPI → 5000</li>
                      <li>Spring Boot → 8080</li>
                    </ul>
                    <p className="mt-1.5 text-muted-foreground">
                      For Git apps, <code className="font-mono">PORT</code> is added automatically to the deployment. Most apps should work with the default value.
                    </p>
                  </HelpTooltip>
                </Label>
                <Input
                  id="port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => router.push(`/dashboard/projects/${projectSlug}`)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {submitting ? "Adding…" : "Add app"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
