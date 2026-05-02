"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import * as api from "@/lib/api"
import type { Project } from "@canette/types"

export default function ProjectSettingsPage() {
  const { slug } = useParams<{ slug: string }>()
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Settings form
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  // Danger zone — slug rename
  const [newSlug, setNewSlug] = useState("")
  const [dangerConfirmed, setDangerConfirmed] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState("")

  // Danger zone — delete
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  useEffect(() => {
    fetch(`/api/v1/projects/${slug}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Project not found")
        return r.json()
      })
      .then((p: Project) => {
        setProject(p)
        setName(p.name)
        setDescription(p.description ?? "")
        setNewSlug(p.slug)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug])

  const isDirty = project && (name !== project.name || description !== (project.description ?? ""))

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!project) return
    setSaveError("")
    setSaving(true)
    try {
      const updated = await api.projects.update(project.id, { name, description })
      setProject(updated)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function handleRename() {
    if (!project) return
    setRenameError("")
    setRenaming(true)
    try {
      await api.projects.update(project.id, { slug: newSlug })
      router.push(`/dashboard/projects/${newSlug}/settings`)
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : "Rename failed")
      setRenaming(false)
    }
  }

  async function handleDelete() {
    if (!project) return
    setDeleteError("")
    setDeleting(true)
    try {
      await api.projects.delete(project.id)
      router.push("/dashboard")
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed")
      setDeleting(false)
    }
  }


  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error || !project) return <p className="text-destructive text-sm">{error || "Project not found"}</p>

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">

        {/* Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proj-name">Name</Label>
                <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proj-desc">
                  Description
                  <span className="ml-2 text-xs text-muted-foreground font-normal">optional</span>
                </Label>
                <Input
                  id="proj-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this project do?"
                />
              </div>
              {saveError && <p className="text-sm text-destructive">{saveError}</p>}
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={!isDirty || saving}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <p className="text-sm font-medium mb-1">Update project slug</p>
              <p className="text-sm text-muted-foreground">
                Updating the slug changes the app URLs. All apps must be stopped to allow this update.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proj-slug">Project slug</Label>
              <Input
                id="proj-slug"
                value={newSlug}
                onChange={(e) => { setNewSlug(e.target.value); setDangerConfirmed(false) }}
                className="font-mono"
              />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
              <Checkbox
                checked={dangerConfirmed}
                onCheckedChange={(v) => setDangerConfirmed(v === true)}
                className="mt-0.5"
              />
              I understand this will impact all app URLs in this project
            </label>
            {renameError && <p className="text-sm text-destructive">{renameError}</p>}
            <div className="flex justify-end">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRename}
                disabled={!newSlug || newSlug === project.slug || !dangerConfirmed || renaming}
              >
                {renaming ? "Renaming…" : "Rename project"}
              </Button>
            </div>

            <div className="border-t border-destructive/20 pt-4 mt-2 flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium mb-1">Delete project</p>
                <p className="text-sm text-muted-foreground">
                  Permanently deletes this project and all its apps, deployments, and deployed
                  Kubernetes services. This cannot be undone.
                </p>
              </div>
              <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={deleteConfirmed}
                  onCheckedChange={(v) => setDeleteConfirmed(v === true)}
                  className="mt-0.5"
                />
                I understand this will permanently delete the project and all deployed services
              </label>
              {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={!deleteConfirmed || deleting}
                >
                  {deleting ? "Deleting…" : "Delete project"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
