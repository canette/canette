"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Bot, CircleCheck, KeyRound, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { FormError } from "@/components/ui/form-error"
import { EnvValueField } from "@/components/env-value-field"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"

// Same limits as the request_secret MCP tool (apps/api/src/services/mcp.ts).
// Enforced again here because the link's query string can be edited by hand.
const MAX_KEYS = 10
const MAX_REASON = 300
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/

type Existing = "secret" | "env" | null

function parseKeys(raw: string | null): { valid: string[]; invalid: string[] } {
  const keys = [...new Set((raw ?? "").split(",").map((k) => k.trim()).filter(Boolean))]
  const valid = keys.filter((k) => KEY_PATTERN.test(k))
  return {
    valid: valid.slice(0, MAX_KEYS),
    invalid: [...keys.filter((k) => !KEY_PATTERN.test(k)), ...valid.slice(MAX_KEYS)],
  }
}

export default function RequestSecretsPage() {
  const { app } = useAppContext()
  const searchParams = useSearchParams()
  const { valid: keys, invalid } = useMemo(() => parseKeys(searchParams.get("keys")), [searchParams])
  // Agent-supplied text: rendered as plain text only, never as markup or a link.
  const reason = (searchParams.get("reason") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON)

  // Keyed on the request, so a different link (even via client-side
  // navigation) starts with a fresh form: no values, consent or "Saved"
  // state carry over, and the old request's lookups land on an unmounted form.
  return <RequestSecretsForm key={`${app.id}:${keys.join(",")}`} keys={keys} invalid={invalid} reason={reason} />
}

function RequestSecretsForm({ keys, invalid, reason }: { keys: string[]; invalid: string[]; reason: string }) {
  const { app, project } = useAppContext()
  const [existing, setExisting] = useState<Record<string, Existing> | null>(null)
  const [loadError, setLoadError] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [convert, setConvert] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let current = true
    api.env.list(app.id).then((data) => {
      if (!current) return
      const secretKeys = new Set(data.secrets.map((s) => s.key))
      const envKeys = new Set(data.envVars.map((v) => v.key))
      setExisting(Object.fromEntries(keys.map((k) => [k, secretKeys.has(k) ? "secret" : envKeys.has(k) ? "env" : null])))
    }).catch((e: unknown) => {
      if (current) setLoadError(e instanceof Error ? e.message : "Failed to load environment")
    })
    return () => { current = false }
  }, [app.id, keys])

  const pending = keys.filter((k) => !saved.includes(k))
  const filled = pending.filter((k) => (values[k] ?? "") !== "")
  const blocked = filled.some((k) => existing?.[k] === "env" && !convert[k])

  async function handleSave() {
    setSaving(true)
    setErrors({})
    const failed: Record<string, string> = {}
    const ok: string[] = []
    // One at a time, so a failure on one key doesn't hide which others succeeded.
    for (const key of filled) {
      try {
        // Values are deliberately not trimmed: PEM blocks and keys can end in a newline.
        await api.env.putSecret(app.id, key, values[key]!, { replaceEnvVar: existing?.[key] === "env" && convert[key] })
        ok.push(key)
      } catch (e: unknown) {
        failed[key] = e instanceof Error ? e.message : "Failed to save"
      }
    }
    setSaved((prev) => [...prev, ...ok])
    setValues((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !ok.includes(k))))
    setErrors(failed)
    setSaving(false)
    if (Object.keys(failed).length === 0 && pending.length === ok.length) setDone(true)
  }

  const settingsHref = `/dashboard/projects/${project.slug}/apps/${app.slug}/settings#environment`

  if (keys.length === 0) {
    return (
      <div className="max-w-2xl">
        <FormError message={invalid.length ? `No valid secret names in this link: ${invalid.join(", ")}` : "This link doesn't name any secrets."} />
      </div>
    )
  }

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            Set secrets for {app.name}
          </CardTitle>
          <CardDescription>
            An AI agent asked you to set {keys.length === 1 ? "this secret" : "these secrets"}. Values you enter here go
            straight to canette: they are encrypted at rest, never shown again and never sent to the agent. The app&apos;s
            code and anyone who can deploy it will be able to use them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {reason && (
            <div className="rounded-md border border-border bg-panel-soft px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                <Bot className="size-3.5" />
                Reason given by the agent
              </p>
              <p className="text-sm whitespace-pre-wrap break-words">{reason}</p>
            </div>
          )}

          {invalid.length > 0 && (
            <FormError message={`Ignored invalid or extra names: ${invalid.join(", ")}`} />
          )}
          {loadError && <FormError message={loadError} />}

          {done ? (
            <div className="flex items-start gap-2 rounded-md bg-success-soft px-3 py-3 text-sm text-success-text">
              <CircleCheck className="size-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Saved {saved.length === 1 ? "1 secret" : `${saved.length} secrets`}.</p>
                <p>Go back to your agent and tell it you&apos;re done. Secrets take effect on the next deployment, which the agent can start for you.</p>
              </div>
            </div>
          ) : existing === null && !loadError ? (
            <div className="flex flex-col gap-3">
              {keys.map((k) => <Skeleton key={k} className="h-16 w-full" />)}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {keys.map((key) => {
                const state = existing?.[key] ?? null
                const isSaved = saved.includes(key)
                return (
                  <div key={key} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`secret-${key}`} className="font-mono text-sm">{key}</Label>
                      {isSaved ? (
                        <span className="text-xs text-success-text">Saved</span>
                      ) : state === "secret" ? (
                        <span className="text-xs text-muted-foreground">Replaces the current value</span>
                      ) : null}
                    </div>
                    {!isSaved && (
                      <>
                        <EnvValueField
                          id={`secret-${key}`}
                          value={values[key] ?? ""}
                          onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
                          isSecret
                          placeholder="Value"
                        />
                        {state === "env" && (
                          <div className="flex flex-col gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text ring-1 ring-inset ring-warning-line">
                            <p className="flex items-start gap-2">
                              <TriangleAlert className="size-4 mt-0.5 shrink-0" />
                              {key} is currently a plain environment variable, readable by your whole team.
                            </p>
                            <div className="flex items-center gap-2">
                              <Checkbox
                                id={`convert-${key}`}
                                checked={!!convert[key]}
                                onCheckedChange={(c) => setConvert((prev) => ({ ...prev, [key]: c === true }))}
                              />
                              <Label htmlFor={`convert-${key}`} className="text-sm font-normal">
                                Convert to a secret (the plaintext value will be deleted)
                              </Label>
                            </div>
                          </div>
                        )}
                        {errors[key] && <FormError message={errors[key]} />}
                      </>
                    )}
                  </div>
                )
              })}

              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving || filled.length === 0 || blocked}>
                  {saving ? "Saving…" : filled.length > 1 ? `Save ${filled.length} secrets` : "Save secret"}
                </Button>
                {blocked && <span className="text-xs text-muted-foreground">Tick “Convert to a secret” to replace a plain variable.</span>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        All of this app&apos;s variables and secrets are under <Link href={settingsHref} className="underline underline-offset-2">Settings → Environment</Link>.
      </p>
    </div>
  )
}
