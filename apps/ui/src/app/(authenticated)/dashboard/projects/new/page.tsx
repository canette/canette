"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

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
    if (slugState !== "available") return
    setError("")
    setSubmitting(true)

    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), slug, description: description.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Something went wrong"); return }
      router.push(`/dashboard/projects/${data.slug}`)
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
    taken: <span className="text-destructive">Already taken</span>,
    invalid: <span className="text-destructive">Lowercase letters, numbers and hyphens only; cannot start or end with a hyphen</span>,
  }[slugState]

  const canSubmit = !!name.trim() && slugState === "available" && !submitting

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-3">
          <a href="/dashboard" className="text-sm font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors">
            canette
          </a>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium">New project</span>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>New project</CardTitle>
            <CardDescription>A project groups your apps and shared configuration.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="My Project"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="slug">
                  Slug
                  <span className="ml-2 text-xs text-muted-foreground font-normal">(used in you app URLs)</span>
                </Label>
                <Input
                  id="slug"
                  placeholder="my-project"
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }}
                  className={cn(
                    slugState === "taken" || slugState === "invalid" ? "border-destructive" : "",
                    slugState === "available" ? "border-green-500" : "",
                  )}
                />
                <p className="text-xs min-h-[1rem]">{slugHint}</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">
                  Description
                  <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                </Label>
                <Input
                  id="description"
                  placeholder="What is this project for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => router.push("/dashboard")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {submitting ? "Creating…" : "Create project"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
