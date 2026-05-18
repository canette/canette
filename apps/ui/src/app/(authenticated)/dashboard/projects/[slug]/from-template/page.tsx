"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { ClipboardPaste } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card"
import { FormError } from "@/components/ui/form-error"
import { AppFormFields, toSlug, isValidEnvKey } from "@/components/app-form-fields"
import type { AppFormValue } from "@/components/app-form-fields"
import * as api from "@/lib/api"
import { resolveTemplateVars, buildSlugMap } from "@/lib/template"
import type { AppTemplate, GitCredential, Project } from "@canette/types"

// ── Types ────────────────────────────────────────────────────────────────────

type CreationStatus = "pending" | "creating" | "done" | "error"

// ── Helpers ──────────────────────────────────────────────────────────────────

function formValueFromTemplate(app: AppTemplate["apps"][number]): AppFormValue {
  const envRows = [
    ...Object.entries(app.env ?? {}).map(([key, value]) => ({ key, value, isSecret: false })),
    ...(app.secrets ?? []).map((s) => ({ key: s.name, value: "", isSecret: true, description: s.description })),
  ]
  return {
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
    envRows,
    canetteConfig: app.canetteConfig ?? "",
  }
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FromTemplatePage() {
  const { slug: projectSlug } = useParams<{ slug: string }>()
  const router = useRouter()

  const [project, setProject] = useState<Project | null>(null)
  const [credentials, setCredentials] = useState<GitCredential[]>([])

  // Template load state
  const [loaded, setLoaded] = useState(false)
  const [template, setTemplate] = useState<AppTemplate | null>(null)
  const [originalSlugs, setOriginalSlugs] = useState<string[]>([])
  const [appForms, setAppForms] = useState<AppFormValue[]>([])

  // Load form state
  const [yamlText, setYamlText] = useState("")
  const [loadError, setLoadError] = useState("")
  const [loading, setLoading] = useState(false)

  // Creation state
  const [creationStatuses, setCreationStatuses] = useState<CreationStatus[]>([])
  const [creationErrors, setCreationErrors] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.projects.get(projectSlug).then(setProject).catch(() => {})
    api.projects.listCredentials(projectSlug).then(setCredentials).catch(() => {})
  }, [projectSlug])

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function updateApp(index: number, patch: Partial<AppFormValue>) {
    setAppForms((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  function currentSlugMap(): Record<string, string> {
    return buildSlugMap(
      appForms.map((f, i) => ({ originalSlug: originalSlugs[i] ?? f.slug, chosenSlug: f.slug })),
    )
  }

  // ── Load template ────────────────────────────────────────────────────────────

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      setYamlText(text)
      setLoadError("")
    } catch {
      // Clipboard access denied — user can paste manually
    }
  }

  async function handleLoad() {
    setLoadError("")
    if (!yamlText.trim()) {
      setLoadError("Paste a template first")
      return
    }
    setLoading(true)
    try {
      const parsed = await api.templates.parse({ yaml: yamlText.trim() })
      setTemplate(parsed)
      setOriginalSlugs(parsed.apps.map((a) => a.slug))
      setAppForms(parsed.apps.map(formValueFromTemplate))
      setCreationStatuses(parsed.apps.map(() => "pending"))
      setCreationErrors(parsed.apps.map(() => ""))
      setLoaded(true)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load template")
    } finally {
      setLoading(false)
    }
  }

  // ── Per-app name change (mirrors name → slug auto-gen from template slug) ───

  function handleNameChange(index: number, value: string) {
    const form = appForms[index]
    const wasAutoSlug = toSlug(form.name) === form.slug
    updateApp(index, { name: value, ...(wasAutoSlug ? { slug: toSlug(value) } : {}) })
  }

  // ── Validation ────────────────────────────────────────────────────────────────

  function allAppsValid(): boolean {
    return appForms.every((form) => {
      if (!form.name.trim()) return false
      if (form.slugState !== "available") return false
      if (form.sourceType === "git" && !form.gitUrl.trim()) return false
      if (form.sourceType === "image" && !form.imageUrl.trim()) return false
      const port = parseInt(form.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) return false
      if (form.envRows.some((r) => r.key.trim() && !isValidEnvKey(r.key.trim()))) return false
      return true
    })
  }

  // ── Create all apps ───────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!project) return
    setCreating(true)

    const slugMap = buildSlugMap(
      appForms.map((f, i) => ({ originalSlug: originalSlugs[i] ?? f.slug, chosenSlug: f.slug })),
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

        for (const { key, value, isSecret } of form.envRows) {
          if (!key.trim()) continue
          if (isSecret) {
            await api.env.putSecret(created.id, key.trim(), value)
          } else {
            await api.env.putVar(created.id, key.trim(), resolveTemplateVars(value, slugMap))
          }
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

  // ── Render: Load template ─────────────────────────────────────────────────────

  if (!loaded) {
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
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Template YAML</Label>
                <button
                  type="button"
                  onClick={handlePasteFromClipboard}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ClipboardPaste className="size-3.5" />
                  Paste from clipboard
                </button>
              </div>
              <Textarea
                placeholder={`name: "Full-stack starter"\napps:\n  - name: API\n    slug: api\n    source_type: git\n    git_url: https://github.com/org/repo\n    port: 3000`}
                value={yamlText}
                onChange={(e) => setYamlText(e.target.value)}
                className="font-mono text-xs min-h-[280px]"
              />
            </div>

            {loadError && <FormError message={loadError} />}

            <div className="flex justify-end gap-3">
              <Button variant="ghost" asChild>
                <a href={`/dashboard/projects/${projectSlug}`}>Cancel</a>
              </Button>
              <Button onClick={handleLoad} disabled={loading}>
                {loading ? "Loading…" : "Load template"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Render: App configuration ─────────────────────────────────────────────────

  const slugMap = currentSlugMap()
  const allDone = creationStatuses.every((s) => s === "done")

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Configure apps</h1>
      {template && (
        <p className="text-sm text-muted-foreground mb-6">
          {template.name}{template.description ? ` — ${template.description}` : ""}
          {" · "}{appForms.length} app{appForms.length !== 1 ? "s" : ""}
        </p>
      )}

      <div className="flex flex-col gap-6">
        {appForms.map((form, i) => {
          const status = creationStatuses[i]
          return (
            <Card key={i}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      App {i + 1}{form.name ? `: ${form.name}` : ""}
                    </p>

                  </div>
                  <div className="shrink-0 text-sm">
                    {status === "creating" && (
                      <span className="text-muted-foreground animate-pulse">Creating…</span>
                    )}
                    {status === "done" && <span className="text-green-500">Created</span>}
                    {status === "error" && <span className="text-destructive">Failed</span>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 pt-2">
                {project && (
                  <AppFormFields
                    value={form}
                    onChange={(patch) => {
                      // Keep name → slug in sync if slug was auto-generated from the original template slug
                      if (patch.name !== undefined && patch.slug === undefined) {
                        handleNameChange(i, patch.name)
                        return
                      }
                      updateApp(i, patch)
                    }}
                    projectId={project.id}
                    credentials={credentials}
                    teamId={project.teamId}
                    slugMap={slugMap}
                    autoFocus={i === 0}
                  />
                )}
                {creationErrors[i] && <FormError message={creationErrors[i]} />}
              </CardContent>
            </Card>
          )
        })}

        {!allDone && (
          <Card>
            <CardContent className="flex justify-end gap-3 py-4">
              <Button variant="ghost" onClick={() => setLoaded(false)} disabled={creating}>
                Back
              </Button>
              <Button onClick={handleCreate} disabled={creating || !allAppsValid()}>
                {creating
                  ? "Creating…"
                  : `Create ${appForms.length} app${appForms.length !== 1 ? "s" : ""}`}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
