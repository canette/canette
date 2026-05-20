"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { FormError } from "@/components/ui/form-error"
import { AppFormFields, defaultAppFormValue, isValidEnvKey } from "@/components/app-form-fields"
import type { AppFormValue } from "@/components/app-form-fields"
import * as api from "@/lib/api"
import type { GitCredential, Project } from "@canette/types"

export default function NewAppPage() {
  const { slug: projectSlug } = useParams<{ slug: string }>()
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [form, setForm] = useState<AppFormValue>(defaultAppFormValue)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api.projects.get(projectSlug)
      .then(setProject)
      .catch(() => setError("Failed to load project"))
    api.projects.listCredentials(projectSlug).then(setCredentials).catch(() => {})
  }, [projectSlug])

  function handleChange(patch: Partial<AppFormValue>) {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!project || form.slugState !== "available") return
    setError("")
    setSubmitting(true)

    try {
      const port = parseInt(form.port, 10)
      const appBody =
        form.sourceType === "git"
          ? {
              name: form.name.trim(),
              slug: form.slug,
              sourceType: "git" as const,
              deploymentType: form.deploymentType,
              schedule: form.deploymentType === "cronjob" ? form.schedule.trim() : undefined,
              gitUrl: form.gitUrl.trim(),
              gitBranch: form.gitBranch.trim() || "main",
              appPath: form.appPath.trim() || undefined,
              gitCredentialId: form.gitCredentialId || undefined,
              port: form.deploymentType !== "cronjob" ? port : undefined,
            }
          : {
              name: form.name.trim(),
              slug: form.slug,
              sourceType: "image" as const,
              deploymentType: form.deploymentType,
              schedule: form.deploymentType === "cronjob" ? form.schedule.trim() : undefined,
              imageUrl: form.imageUrl.trim(),
              imageTag: form.imageTag.trim() || "latest",
              port: form.deploymentType !== "cronjob" ? port : undefined,
            }

      const res = await fetch(`/api/v1/projects/${project.id}/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(appBody),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Something went wrong"); return }

      for (const { key, value, isSecret } of form.envRows) {
        if (!key.trim()) continue
        if (isSecret) {
          await api.env.putSecret(data.id, key.trim(), value)
        } else {
          await api.env.putVar(data.id, key.trim(), value)
        }
      }

      router.push(`/dashboard/projects/${projectSlug}/apps/${data.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  const sourceReady = form.sourceType === "git" ? !!form.gitUrl.trim() : !!form.imageUrl.trim()
  const envKeysValid = form.envRows.every((r) => !r.key.trim() || isValidEnvKey(r.key.trim()))
  const canSubmit = !!form.name.trim() && sourceReady && form.slugState === "available" && envKeysValid && !!project && !submitting

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Add app</h1>
      <Card>
        <CardHeader>
          <CardDescription>Connect a Git repository or Docker image to deploy.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {project && (
              <AppFormFields
                value={form}
                onChange={handleChange}
                projectId={project.id}
                credentials={credentials}
                teamId={project.teamId}
                parseGitUrl
                autoSlug
                autoFocus
              />
            )}

            {error && <FormError message={error} />}

            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => router.push(`/dashboard/projects/${projectSlug}`)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {submitting ? "Adding…" : "Add app"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
