"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import * as api from "@/lib/api"
import type { Team } from "@canette/types"

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
}

type SlugState = "idle" | "checking" | "available" | "taken" | "invalid"

export default function NewProjectPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugState, setSlugState] = useState<SlugState>("idle")
  const [description, setDescription] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<string>("")

  // Load user's teams
  useEffect(() => {
    api.teams.list().then((data) => {
      setTeams(data)
      if (data.length > 0) setTeamId(data[0].id)
    }).catch(() => {})
  }, [])

  // Auto-derive slug from name unless user has manually edited it
  useEffect(() => {
    if (!slugEdited) {
      setSlug(toSlug(name))
    }
  }, [name, slugEdited])

  // Debounced slug availability check
  useEffect(() => {
    if (checkTimer.current) clearTimeout(checkTimer.current)
    if (!slug) { setSlugState("idle"); return }

    const valid = /^[a-z0-9][a-z0-9-]{0,57}$/.test(slug) && !slug.endsWith("-")
    if (!valid) { setSlugState("invalid"); return }

    setSlugState("checking")
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/projects/slug-available?slug=${encodeURIComponent(slug)}`, { credentials: "include" })
        const data = await res.json()
        setSlugState(data.available ? "available" : "taken")
      } catch {
        setSlugState("idle")
      }
    }, 400)

    return () => { if (checkTimer.current) clearTimeout(checkTimer.current) }
  }, [slug])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (slugState !== "available" || !teamId) return
    setError("")
    setSubmitting(true)

    try {
      const data = await api.projects.create({
        teamId,
        name: name.trim(),
        slug,
        description: description.trim() || undefined,
      })
      router.refresh()
      router.push(`/dashboard/projects/${data.slug}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  const slugHint = {
    idle: null,
    checking: <span className="text-muted-foreground">Checking…</span>,
    available: <span className="text-green-500">Available</span>,
    taken: <span className="text-destructive">Already taken</span>,
    invalid: <span className="text-destructive">Lowercase letters, numbers and hyphens only; cannot start or end with a hyphen</span>,
  }[slugState]

  const canSubmit = !!name.trim() && slugState === "available" && !!teamId && !submitting

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">New project</h1>
      <Card>
        <CardHeader>
          <CardDescription>A project groups your apps and shared configuration.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {teams.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="team">Team</Label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger id="team"><SelectValue placeholder="Select a team" /></SelectTrigger>
                  <SelectContent>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        <span className="flex items-center gap-2">
                          {t.name}
                          {t.isPersonal && <Badge variant="muted">personal</Badge>}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" placeholder="My Project" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="slug">Slug <span className="ml-2 text-xs text-muted-foreground font-normal">(used in your app URLs)</span></Label>
              <Input id="slug" placeholder="my-project" value={slug}
                onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }}
                className={cn(
                  slugState === "taken" || slugState === "invalid" ? "border-destructive" : "",
                  slugState === "available" ? "border-green-500" : "",
                )} />
              <p className="text-xs min-h-[1rem]">{slugHint}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Description <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span></Label>
              <Input id="description" placeholder="What is this project for?" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-3 pt-1">
              <Button type="button" variant="ghost" onClick={() => router.push("/dashboard")}>Cancel</Button>
              <Button type="submit" disabled={!canSubmit}>{submitting ? "Creating…" : "Create project"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
