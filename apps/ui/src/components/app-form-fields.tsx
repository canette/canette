"use client"

import { useState, useEffect, useRef } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { HelpTooltip } from "@/components/ui/tooltip"
import { CredentialSelect } from "@/components/credential-select"
import { cn } from "@/lib/utils"
import { resolveTemplateVars, hasTemplateVars } from "@/lib/template"
import type { GitCredential } from "@canette/types"

// ── Types ────────────────────────────────────────────────────────────────────

export type SlugState = "idle" | "checking" | "available" | "taken" | "invalid"

export type AppFormValue = {
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
  envRows: Array<{ key: string; value: string; isSecret: boolean; description?: string }>
  canetteConfig: string
}

export function defaultAppFormValue(): AppFormValue {
  return {
    name: "",
    slug: "",
    slugState: "idle",
    sourceType: "git",
    gitUrl: "",
    gitBranch: "main",
    appPath: "",
    imageUrl: "",
    imageTag: "latest",
    port: "3000",
    gitCredentialId: "",
    envRows: [],
    canetteConfig: "",
  }
}

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63)
}

export function isValidEnvKey(key: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(key)
}

function parseGitUrlHelper(raw: string): { gitUrl: string; branch: string; appPath: string } | null {
  const gh = raw.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)(\/.*)?$/)
  if (gh) return { gitUrl: gh[1], branch: gh[2], appPath: gh[3] ?? "" }
  const gl = raw.match(/^(https:\/\/gitlab\.com\/[^/]+\/[^/]+)\/-\/tree\/([^/]+)(\/.*)?$/)
  if (gl) return { gitUrl: gl[1], branch: gl[2], appPath: gl[3] ?? "" }
  return null
}

// ── Props ────────────────────────────────────────────────────────────────────

type AppFormFieldsProps = {
  value: AppFormValue
  onChange: (patch: Partial<AppFormValue>) => void
  projectId: string
  credentials: GitCredential[]
  teamId?: string
  // Template-only: slugMap for {{apps.X.slug}} resolution display in env values
  slugMap?: Record<string, string>
  // Enables parseGitUrl: detects branch/path from GitHub/GitLab browse URLs
  parseGitUrl?: boolean
  // When true, name changes auto-update slug (until user manually edits slug)
  autoSlug?: boolean
  autoFocus?: boolean
}

// ── Component ────────────────────────────────────────────────────────────────

export function AppFormFields({
  value,
  onChange,
  projectId,
  credentials,
  teamId,
  slugMap,
  parseGitUrl = false,
  autoSlug = false,
  autoFocus = false,
}: AppFormFieldsProps) {
  const slugEdited = useRef(false)
  const [urlParsed, setUrlParsed] = useState(false)
  const [envOpen, setEnvOpen] = useState(() => value.envRows.length > 0)
  const [advancedOpen, setAdvancedOpen] = useState(() => !!value.canetteConfig)
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (checkTimer.current) clearTimeout(checkTimer.current)
    const slug = value.slug

    if (!slug) {
      onChange({ slugState: "idle" })
      return
    }

    const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !slug.endsWith("-")
    if (!valid) {
      onChange({ slugState: "invalid" })
      return
    }

    onChange({ slugState: "checking" })
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/v1/projects/${projectId}/apps/slug-available?slug=${encodeURIComponent(slug)}`,
          { credentials: "include" },
        )
        const data = await res.json()
        onChange({ slugState: data.available ? "available" : "taken" })
      } catch {
        onChange({ slugState: "idle" })
      }
    }, 400)

    return () => { if (checkTimer.current) clearTimeout(checkTimer.current) }
  }, [value.slug, projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleNameChange(v: string) {
    if (autoSlug && !slugEdited.current) {
      onChange({ name: v, slug: toSlug(v) })
    } else {
      onChange({ name: v })
    }
  }

  function handleSlugChange(v: string) {
    slugEdited.current = true
    onChange({ slug: v })
  }

  function handleGitUrlChange(raw: string) {
    if (parseGitUrl) {
      const parsed = parseGitUrlHelper(raw)
      if (parsed) {
        onChange({ gitUrl: parsed.gitUrl, gitBranch: parsed.branch, appPath: parsed.appPath })
        setUrlParsed(true)
        return
      }
      setUrlParsed(false)
    }
    onChange({ gitUrl: raw })
  }

  const slugHint = {
    idle: null,
    checking: <span className="text-muted-foreground">Checking…</span>,
    available: <span className="text-green-500">Available</span>,
    taken: <span className="text-destructive">Already taken in this project</span>,
    invalid: <span className="text-destructive">Lowercase letters, numbers and hyphens only; cannot start or end with a hyphen</span>,
  }[value.slugState]

  return (
    <div className="flex flex-col gap-5">

      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="appName">Name</Label>
        <Input
          id="appName"
          placeholder="My App"
          value={value.name}
          onChange={(e) => handleNameChange(e.target.value)}
          autoFocus={autoFocus}
          required
        />
      </div>

      {/* Slug */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="appSlug">
          Slug
          <span className="ml-2 text-xs text-muted-foreground font-normal">(used as container name)</span>
        </Label>
        <Input
          id="appSlug"
          placeholder="my-app"
          value={value.slug}
          onChange={(e) => handleSlugChange(e.target.value)}
          className={cn(
            value.slugState === "taken" || value.slugState === "invalid" ? "border-destructive" : "",
            value.slugState === "available" ? "border-green-500" : "",
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
            onClick={() => onChange({ sourceType: "git" })}
            className={cn(
              "px-4 py-1.5 text-sm transition-colors",
              value.sourceType === "git"
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            Git
          </button>
          <button
            type="button"
            onClick={() => onChange({ sourceType: "image" })}
            className={cn(
              "px-4 py-1.5 text-sm transition-colors border-l border-border",
              value.sourceType === "image"
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            Docker Image
          </button>
        </div>
      </div>

      {/* Git fields */}
      {value.sourceType === "git" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gitUrl">Git URL</Label>
            <Input
              id="gitUrl"
              placeholder="https://github.com/org/repo"
              value={value.gitUrl}
              onChange={(e) => handleGitUrlChange(e.target.value)}
              required
            />
            {urlParsed && (
              <p className="text-xs text-muted-foreground">Branch and app path were detected from the URL.</p>
            )}
          </div>

          <CredentialSelect
            credentials={credentials}
            value={value.gitCredentialId}
            onChange={(v) => onChange({ gitCredentialId: v })}
            teamId={teamId}
            gitUrl={value.gitUrl}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gitBranch">Branch</Label>
              <Input
                id="gitBranch"
                placeholder="main"
                value={value.gitBranch}
                onChange={(e) => onChange({ gitBranch: e.target.value })}
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
                value={value.appPath}
                onChange={(e) => onChange({ appPath: e.target.value })}
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
              value={value.imageUrl}
              onChange={(e) => onChange({ imageUrl: e.target.value })}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="imageTag">Tag</Label>
            <Input
              id="imageTag"
              placeholder="latest"
              value={value.imageTag}
              onChange={(e) => onChange({ imageTag: e.target.value })}
            />
          </div>
        </div>
      )}

      {/* Port */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="appPort" className="flex items-center gap-1">
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
              For Git apps, <code className="font-mono">PORT</code> is added automatically to the deployment.
            </p>
          </HelpTooltip>
        </Label>
        <Input
          id="appPort"
          type="number"
          min={1}
          max={65535}
          value={value.port}
          onChange={(e) => onChange({ port: e.target.value })}
          className="w-32 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>

      {/* Environment & Secrets (collapsible) */}
      <Collapsible
        open={envOpen}
        onOpenChange={(open) => {
          setEnvOpen(open)
          if (open && value.envRows.length === 0) {
            onChange({ envRows: [{ key: "", value: "", isSecret: false }] })
          }
        }}
      >
        <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <span>{envOpen ? "▾" : "▸"}</span>
          <span>Environment &amp; Secrets</span>
          {value.envRows.filter((r) => r.key).length > 0 && (
            <span className="text-muted-foreground">({value.envRows.filter((r) => r.key).length})</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 flex flex-col gap-2">
          {value.envRows.map((row, ri) => {
            const resolved = !row.isSecret && slugMap && hasTemplateVars(row.value)
              ? resolveTemplateVars(row.value, slugMap)
              : null
            return (
              <div key={ri} className="flex flex-col gap-0.5">
                <div className="flex gap-2 items-center">
                  <Input
                    placeholder="KEY"
                    value={row.key}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
                      const rows = value.envRows.map((r, i) => i === ri ? { ...r, key: next } : r)
                      onChange({ envRows: rows })
                    }}
                    className="font-mono text-xs w-40 shrink-0"
                  />
                  <Input
                    placeholder={row.description ?? "value"}
                    type={row.isSecret ? "password" : "text"}
                    value={row.value}
                    onChange={(e) => {
                      const rows = value.envRows.map((r, i) => i === ri ? { ...r, value: e.target.value } : r)
                      onChange({ envRows: rows })
                    }}
                    className="font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const rows = value.envRows.map((r, i) => i === ri ? { ...r, isSecret: !r.isSecret } : r)
                      onChange({ envRows: rows })
                    }}
                    className={cn(
                      "text-xs shrink-0 px-2 py-1 rounded-md border transition-colors",
                      row.isSecret
                        ? "border-amber-500/50 text-amber-600 bg-amber-500/5 hover:bg-amber-500/10"
                        : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                    aria-label={row.isSecret ? "Switch to plain variable" : "Switch to secret"}
                  >
                    Secret
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ envRows: value.envRows.filter((_, i) => i !== ri) })}
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ envRows: [...value.envRows, { key: "", value: "", isSecret: false }] })}
            className="w-fit"
          >
            + Add
          </Button>
        </CollapsibleContent>
      </Collapsible>

      {/* Advanced configuration (collapsible) */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <span>{advancedOpen ? "▾" : "▸"}</span>
          <span>Advanced configuration</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            Runtime, resource, and ingress settings as <code>canette.yaml</code>. Applied at deploy time; a repo&apos;s <code>canette.yaml</code> overrides these.
          </p>
          <Textarea
            value={value.canetteConfig}
            onChange={(e) => onChange({ canetteConfig: e.target.value })}
            className="font-mono text-xs min-h-[120px]"
            placeholder="# optional — leave blank to use platform defaults"
          />
        </CollapsibleContent>
      </Collapsible>

    </div>
  )
}
