"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import * as api from "@/lib/api"

export default function NewTeamPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setError("")
    setSubmitting(true)
    try {
      const team = await api.teams.create({ name: name.trim() })
      router.push(`/dashboard/teams/${team.id}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors">
            canette
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <Link href="/dashboard/teams" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Teams</Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium">New team</span>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>New team</CardTitle>
            <CardDescription>Create a shared team to collaborate on projects.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Team name</Label>
                <Input
                  id="name"
                  placeholder="e.g. Platform Team"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => router.push("/dashboard/teams")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!name.trim() || submitting}>
                  {submitting ? "Creating…" : "Create team"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
