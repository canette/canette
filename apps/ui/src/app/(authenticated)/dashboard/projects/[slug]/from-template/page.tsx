"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { FormError } from "@/components/ui/form-error"
import { CredentialSelect } from "@/components/credential-select"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import { resolveTemplateVars, hasTemplateVars, buildSlugMap } from "@/lib/template"
import type { AppTemplate, GitCredential, Project } from "@canette/types"

// ── Types ────────────────────────────────────────────────────────────────────

type SlugState = "idle" | "checking" | "available" | "taken" | "invalid"

type AppFormState = {
  originalSlug: string
  name: string
  slug: string
  slugState: SlugState
  sourceType: "git" | "image"
  gitUrl: string
  gitBranch: string
  appPath: string
  imageUrl: string
  imageTag: string
  port: string
  gitCredentialId: string
  envRows: Array<{ key: string; value: string }>
  secretValues: Record<string, string>
  canetteConfig: string
}

type CreationStatus = "pending" | "creating" | "done" | "error"

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63)
}

function formStateFromTemplate(app: AppTemplate["apps"][number]): AppFormState {
  return {
    originalSlug: app.slug,
    name: app.name,
    slug: app.slug,
    slugState: "idle",
    sourceType: app.sourceType,
    gitUrl: app.gitUrl ?? "",
    gitBranch: app.gitBranch ?? "main",
    appPath: app.appPath ?? "",
    imageUrl: app.imageUrl ?? "",
    imageTag: app.imageTag ?? "latest",
    port: app.port?.toString() ?? "3000",
    gitCredentialId: app.gitCredentialId ?? "",
    envRows: app.env
      ? Object.entries(app.env).map(([key, value]) => ({ key, value }))
      : [],
    secretValues: Object.fromEntries((app.secrets ?? []).map((s) => [s.name, ""])),
    canetteConfig: app.canetteConfig ?? "",
  }
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FromTemplatePage() {
  const { slug: projectSlug } = useParams<{ slug: string }>()
  const router = useRouter()

  const [project, setProject] = useState<Project | null>(null)
  const [credentials, setCredentials] = useState<GitCredential[]>([])

  // step: -1 = load, 0..N-1 = per-app, N = summary
  const [step, setStep] = useState(-1)
  const [template, setTemplate] = useState<AppTemplate | null>(null)
  const [appForms, setAppForms] = useState<AppFormState[]>([])

  const [loadInput, setLoadInput] = useState("paste")
  const [yamlText, setYamlText] = useState("")
  const [urlText, setUrlText] = useState("")
  const [loadError, setLoadError] = useState("")
  const [loading, setLoading] = useState(false)

  const [creationStatuses, setCreationStatuses] = useState<CreationStatus[]>([])
  const [creationErrors, setCreationErrors] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  const slugTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.projects.get(projectSlug)
      .then(setProject)
      .catch(() => {})
    api.projects.listCredentials(projectSlug).then(setCredentials).catch(() => {})
  }, [projectSlug])

  // ── Slug live-check for the active app step ─────────────────────────────────

  const runSlugCheck = useCallback(
    (appIndex: number, slug: string) => {
      if (!project) return
      if (slugTimerRef.current) clearTimeout(slugTimerRef.current)

      if (!slug) {
        updateApp(appIndex, { slugState: "idle" })
        return
      }
      const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !slug.endsWith("-")
      if (!valid) {
        updateApp(appIndex, { slugState: "invalid" })
        return
      }

      updateApp(appIndex, { slugState: "checking" })
      slugTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(
            `/api/v1/projects/${project.id}/apps/slug-available?slug=${encodeURIComponent(slug)}`,
            { credentials: "include" },
          )
          const data = await res.json()
          updateApp(appIndex, { slugState: data.available ? "available" : "taken" })
        } catch {
          updateApp(appIndex, { slugState: "idle" })
        }
      }, 400)
    },
    [project],
  )

  // Re-run check when project loads for the active step
  useEffect(() => {
    if (step >= 0 && step < appForms.length && project) {
      runSlugCheck(step, appForms[step].slug)
    }
  }, [step, project]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── State helpers ───────────────────────────────────────────────────────────

  function updateApp(index: number, patch: Partial<AppFormState>) {
    setAppForms((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  // ── Load template ───────────────────────────────────────────────────────────

  async function handleLoad() {
    setLoadError("")
    setLoading(true)
    try {
      const body = loadInput === "url" ? { url: urlText.trim() } : { yaml: yamlText.trim() }
      if (!body.yaml && !body.url) {
        setLoadError(loadInput === "url" ? "Enter a URL" : "Paste a template first")
        return
      }
      const parsed = await api.templates.parse(body)
      setTemplate(parsed)
      setAppForms(parsed.apps.map(formStateFromTemplate))
      setCreationStatuses(parsed.apps.map(() => "pending"))
      setCreationErrors(parsed.apps.map(() => ""))
      setStep(0)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load template")
    } finally {
      setLoading(false)
    }
  }

  // ── Per-app field handlers ───────────────────────────────────────────────────

  function handleSlugChange(index: number, value: string) {
    updateApp(index, { slug: value })
    runSlugCheck(index, value)
  }

  function handleNameChange(index: number, value: string) {
    const form = appForms[index]
    const auto = toSlug(form.name) === form.slug
    updateApp(index, { name: value, ...(auto ? { slug: toSlug(value) } : {}) })
    if (auto) runSlugCheck(index, toSlug(value))
  }

  // ── Env row helpers ──────────────────────────────────────────────────────────

  function addEnvRow(index: number) {
    updateApp(index, {
      envRows: [...appForms[index].envRows, { key: "", value: "" }],
    })
  }

  function updateEnvRow(
    appIndex: number,
    rowIndex: number,
    field: "key" | "value",
    value: string,
  ) {
    const rows = appForms[appIndex].envRows.map((r, i) =>
      i === rowIndex ? { ...r, [field]: value } : r,
    )
    updateApp(appIndex, { envRows: rows })
  }

  function removeEnvRow(appIndex: number, rowIndex: number) {
    updateApp(appIndex, {
      envRows: appForms[appIndex].envRows.filter((_, i) => i !== rowIndex),
    })
  }

  // ── Current slug map (for template var preview) ──────────────────────────────

  function currentSlugMap(): Record<string, string> {
    return buildSlugMap(
      appForms.map((f) => ({ originalSlug: f.originalSlug, chosenSlug: f.slug })),
    )
  }

  // ── Validation for the current step ─────────────────────────────────────────

  function currentStepValid(): boolean {
    if (step < 0 || step >= appForms.length) return true
    const form = appForms[step]
    if (!form.name.trim()) return false
    if (form.slugState !== "available") return false
    if (form.sourceType === "git" && !form.gitUrl.trim()) return false
    if (form.sourceType === "image" && !form.imageUrl.trim()) return false
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1 || port > 65535) return false
    const missingSecrets = Object.entries(form.secretValues).filter(([, v]) => !v)
    if (missingSecrets.length > 0) return false
    return true
  }

  // ── Create all apps ──────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!project) return
    setCreating(true)

    const slugMap = buildSlugMap(
      appForms.map((f) => ({ originalSlug: f.originalSlug, chosenSlug: f.slug })),
    )

    for (let i = 0; i < appForms.length; i++) {
      const form = appForms[i]
      setCreationStatuses((prev) => prev.map((s, idx) => (idx === i ? "creating" : s)))

      try {
        const port = parseInt(form.port, 10)
        const appBody =
          form.sourceType === "git"
            ? {
                name: form.name.trim(),
                slug: form.slug,
                sourceType: "git" as const,
                gitUrl: form.gitUrl.trim(),
                gitBranch: form.gitBranch.trim() || "main",
                appPath: form.appPath.trim() || undefined,
                gitCredentialId: form.gitCredentialId || undefined,
                port,
                canetteConfig: form.canetteConfig.trim() || undefined,
              }
            : {
                name: form.name.trim(),
                slug: form.slug,
                sourceType: "image" as const,
                imageUrl: form.imageUrl.trim(),
                imageTag: form.imageTag.trim() || "latest",
                port,
                canetteConfig: form.canetteConfig.trim() || undefined,
              }

        const created = await api.apps.create(project.id, appBody)

        // Set env vars (resolve cross-app references)
        for (const { key, value } of form.envRows) {
          if (!key.trim()) continue
          const resolved = resolveTemplateVars(value, slugMap)
          await api.env.putVar(created.id, key.trim(), resolved)
        }

        // Set secrets
        for (const [key, value] of Object.entries(form.secretValues)) {
          if (value) await api.env.putSecret(created.id, key, value)
        }

        setCreationStatuses((prev) => prev.map((s, idx) => (idx === i ? "done" : s)))
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to create app"
        setCreationStatuses((prev) => prev.map((s, idx) => (idx === i ? "error" : s)))
        setCreationErrors((prev) => prev.map((s, idx) => (idx === i ? msg : s)))
        setCreating(false)
        return
      }
    }

    setCreating(false)
    router.push(`/dashboard/projects/${projectSlug}`)
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  function slugHint(state: SlugState) {
    return {
      idle: null,
      checking: <span className="text-muted-foreground">Checking…</span>,
      available: <span className="text-green-500">Available</span>,
      taken: <span className="text-destructive">Already taken in this project</span>,
      invalid: <span className="text-destructive">Lowercase letters, numbers and hyphens only</span>,
    }[state]
  }

  const totalApps = appForms.length

  // ── Step: Load ───────────────────────────────────────────────────────────────

  if (step === -1) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-6">From template</h1>
        <Card className="max-w-2xl">
          <CardHeader>
            <CardDescription>
              Load a <code className="text-xs">canette-template.yaml</code> file to create one or more apps at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-4">
              <div className="flex rounded-md border border-border overflow-hidden w-fit">
                <button
                  type="button"
                  onClick={() => setLoadInput("paste")}
                  className={cn(
                    "px-4 py-1.5 text-sm transition-colors",
                    loadInput === "paste"
                      ? "bg-foreground text-background font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  Paste YAML
                </button>
                <button
                  type="button"
                  onClick={() => setLoadInput("url")}
                  className={cn(
                    "px-4 py-1.5 text-sm transition-colors border-l border-border",
                    loadInput === "url"
                      ? "bg-foreground text-background font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  From URL
                </button>
              </div>

              {loadInput === "paste" ? (
                <Textarea
                  placeholder={`name: "Full-stack starter"\napps:\n  - name: API\n    slug: api\n    source_type: git\n    git_url: https://github.com/org/repo\n    port: 3000`}
                  value={yamlText}
                  onChange={(e) => setYamlText(e.target.value)}
                  className="font-mono text-xs min-h-[200px]"
                />
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="templateUrl">Template URL</Label>
                  <Input
                    id="templateUrl"
                    placeholder="https://raw.githubusercontent.com/org/repo/main/canette-template.yaml"
                    value={urlText}
                    onChange={(e) => setUrlText(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be a public URL. The file is fetched server-side.
                  </p>
                </div>
              )}
            </div>

            {loadError && <FormError message={loadError} />}

            <div className="flex gap-3">
              <Button onClick={handleLoad} disabled={loading}>
                {loading ? "Loading…" : "Load template"}
              </Button>
              <Button variant="ghost" asChild>
                <a href={`/dashboard/projects/${projectSlug}`}>Cancel</a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Step: Summary / Create ────────────────────────────────────────────────────

  if (step === totalApps) {
    const allDone = creationStatuses.every((s) => s === "done")

    return (
      <div>
        <h1 className="text-xl font-semibold mb-2">Review and create</h1>
        <p className="text-sm text-muted-foreground mb-6">
          {template?.name} — {totalApps} app{totalApps !== 1 ? "s" : ""} will be added to this project.
        </p>

        <div className="flex flex-col gap-3 max-w-2xl mb-6">
          {appForms.map((form, i) => {
            const status = creationStatuses[i]
            return (
              <Card key={i}>
                <CardContent className="flex items-center justify-between gap-3 py-4">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <p className="text-sm font-medium truncate">{form.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{form.slug}</p>
                    <p className="text-xs text-muted-foreground">
                      {form.sourceType === "git" ? form.gitUrl || "—" : `${form.imageUrl}:${form.imageTag}`}
                    </p>
                    {(() => {
                      const envCount = form.envRows.filter(r => r.key).length
                      const secretCount = Object.keys(form.secretValues).length
                      const parts = []
                      if (envCount > 0) parts.push(`${envCount} env var${envCount !== 1 ? "s" : ""}`)
                      if (secretCount > 0) parts.push(`${secretCount} secret${secretCount !== 1 ? "s" : ""}`)
                      return parts.length > 0
                        ? <p className="text-xs text-muted-foreground">{parts.join(", ")}</p>
                        : null
                    })()}
                  </div>
                  <div className="shrink-0 text-sm">
                    {status === "pending" && <span className="text-muted-foreground">Pending</span>}
                    {status === "creating" && <span className="text-muted-foreground animate-pulse">Creating…</span>}
                    {status === "done" && <span className="text-green-500">Created</span>}
                    {status === "error" && <span className="text-destructive">Failed</span>}
                  </div>
                </CardContent>
                {creationErrors[i] && (
                  <CardContent className="pt-0 pb-4">
                    <FormError message={creationErrors[i]} />
                  </CardContent>
                )}
              </Card>
            )
          })}
        </div>

        {!allDone && (
          <div className="flex gap-3">
            <Button
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? "Creating…" : `Create ${totalApps} app${totalApps !== 1 ? "s" : ""}`}
            </Button>
            <Button variant="outline" onClick={() => setStep(totalApps - 1)} disabled={creating}>
              Back
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ── Step: Per-app review ──────────────────────────────────────────────────────

  const form = appForms[step]
  const slugMap = currentSlugMap()
  const isLastApp = step === totalApps - 1

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-xl font-semibold">App {step + 1} of {totalApps}</h1>
      </div>
      {template && (
        <p className="text-sm text-muted-foreground mb-6">
          {template.name}{template.description ? ` — ${template.description}` : ""}
        </p>
      )}

      <Card className="max-w-2xl">
        <CardContent className="flex flex-col gap-5 pt-6">

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appName">Name</Label>
            <Input
              id="appName"
              value={form.name}
              onChange={(e) => handleNameChange(step, e.target.value)}
              autoFocus
            />
          </div>

          {/* Slug */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appSlug">
              Slug
              <span className="ml-2 text-xs text-muted-foreground font-normal">(container name)</span>
            </Label>
            <Input
              id="appSlug"
              value={form.slug}
              onChange={(e) => handleSlugChange(step, e.target.value)}
              className={cn(
                form.slugState === "taken" || form.slugState === "invalid" ? "border-destructive" : "",
                form.slugState === "available" ? "border-green-500" : "",
              )}
            />
            <p className="text-xs min-h-[1rem]">{slugHint(form.slugState)}</p>
          </div>

          {/* Source type */}
          <div className="flex flex-col gap-1.5">
            <Label>Source</Label>
            <div className="flex rounded-md border border-border overflow-hidden w-fit">
              <button
                type="button"
                onClick={() => updateApp(step, { sourceType: "git" })}
                className={cn(
                  "px-4 py-1.5 text-sm transition-colors",
                  form.sourceType === "git"
                    ? "bg-foreground text-background font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                Git
              </button>
              <button
                type="button"
                onClick={() => updateApp(step, { sourceType: "image" })}
                className={cn(
                  "px-4 py-1.5 text-sm transition-colors border-l border-border",
                  form.sourceType === "image"
                    ? "bg-foreground text-background font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                Docker Image
              </button>
            </div>
          </div>

          {/* Git fields */}
          {form.sourceType === "git" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gitUrl">Git URL</Label>
                <Input
                  id="gitUrl"
                  placeholder="https://github.com/org/repo"
                  value={form.gitUrl}
                  onChange={(e) => updateApp(step, { gitUrl: e.target.value })}
                />
              </div>

              <CredentialSelect
                credentials={credentials}
                value={form.gitCredentialId}
                onChange={(v) => updateApp(step, { gitCredentialId: v })}
                teamId={project?.teamId}
                gitUrl={form.gitUrl}
              />

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="gitBranch">Branch</Label>
                  <Input
                    id="gitBranch"
                    placeholder="main"
                    value={form.gitBranch}
                    onChange={(e) => updateApp(step, { gitBranch: e.target.value })}
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
                    value={form.appPath}
                    onChange={(e) => updateApp(step, { appPath: e.target.value })}
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
                  value={form.imageUrl}
                  onChange={(e) => updateApp(step, { imageUrl: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="imageTag">Tag</Label>
                <Input
                  id="imageTag"
                  placeholder="latest"
                  value={form.imageTag}
                  onChange={(e) => updateApp(step, { imageTag: e.target.value })}
                />
              </div>
            </div>
          )}

          {/* Port */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => updateApp(step, { port: e.target.value })}
              className="w-32"
            />
          </div>

          {/* Env vars */}
          <div className="flex flex-col gap-2">
            <Label>Environment variables</Label>
            {form.envRows.length === 0 && (
              <p className="text-xs text-muted-foreground">No env vars from template.</p>
            )}
            {form.envRows.map((row, ri) => {
              const resolved = hasTemplateVars(row.value)
                ? resolveTemplateVars(row.value, slugMap)
                : null
              return (
                <div key={ri} className="flex flex-col gap-0.5">
                  <div className="flex gap-2 items-center">
                    <Input
                      placeholder="KEY"
                      value={row.key}
                      onChange={(e) => updateEnvRow(step, ri, "key", e.target.value)}
                      className="font-mono text-xs w-40 shrink-0"
                    />
                    <Input
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => updateEnvRow(step, ri, "value", e.target.value)}
                      className="font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvRow(step, ri)}
                      className="text-muted-foreground hover:text-destructive text-xs shrink-0"
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                  {resolved !== null && (
                    <p className="text-xs text-muted-foreground pl-1">
                      → <code>{resolved}</code>
                    </p>
                  )}
                </div>
              )
            })}
            <Button type="button" variant="outline" size="sm" onClick={() => addEnvRow(step)} className="w-fit">
              + Add variable
            </Button>
          </div>

          {/* Required secrets */}
          {template && (template.apps[step]?.secrets ?? []).length > 0 && (
            <div className="flex flex-col gap-3">
              <Label>Secrets</Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Required by the template. Values are encrypted at rest.
              </p>
              {(template.apps[step]?.secrets ?? []).map((secret) => (
                <div key={secret.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={`secret-${secret.name}`} className="font-mono text-xs">
                    {secret.name}
                    <span className="ml-2 text-xs font-sans text-destructive font-normal">required</span>
                  </Label>
                  {secret.description && (
                    <p className="text-xs text-muted-foreground">{secret.description}</p>
                  )}
                  <Input
                    id={`secret-${secret.name}`}
                    type="password"
                    placeholder="secret value"
                    value={form.secretValues[secret.name] ?? ""}
                    onChange={(e) =>
                      updateApp(step, {
                        secretValues: { ...form.secretValues, [secret.name]: e.target.value },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {/* Advanced: canetteConfig */}
          <Collapsible>
            <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              Advanced configuration
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                Runtime, resource, and ingress settings from the template. Applied at deploy time; repo <code>canette.yaml</code> overrides these.
              </p>
              <Textarea
                value={form.canetteConfig}
                onChange={(e) => updateApp(step, { canetteConfig: e.target.value })}
                className="font-mono text-xs min-h-[120px]"
                placeholder="# No extra config from template"
              />
            </CollapsibleContent>
          </Collapsible>

          {/* Navigation */}
          <div className="flex gap-3 pt-2">
            <Button onClick={() => setStep(isLastApp ? totalApps : step + 1)} disabled={!currentStepValid()}>
              {isLastApp ? "Review" : "Next"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setStep(step - 1)}
            >
              {step === 0 ? "Back to load" : "Back"}
            </Button>
          </div>

        </CardContent>
      </Card>
    </div>
  )
}
