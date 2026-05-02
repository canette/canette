"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
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
      await api.teams.create({ name: name.trim() })
      router.push("/admin/teams")
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">New team</h1>
      <Card>
        <CardHeader>
          <CardDescription>Create a shared team to collaborate on projects.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Team name</Label>
              <Input id="name" placeholder="e.g. Platform Team" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-3 pt-1">
              <Button type="button" variant="ghost" onClick={() => router.push("/admin/teams")}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || submitting}>{submitting ? "Creating…" : "Create team"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
