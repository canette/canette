"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, usePathname } from "next/navigation"
import { TabNavigation } from "@/components/tab-navigation"
import { Skeleton } from "@/components/ui/skeleton"
import type { Project } from "@canette/types"

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { slug } = useParams<{ slug: string }>()
  const pathname = usePathname()
  const [project, setProject] = useState<Project | null>(null)

  const isAppPage = pathname.includes(`/projects/${slug}/apps/`)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/projects/${slug}`, { credentials: "include" })
      if (r.ok) setProject(await r.json())
    } catch { /* ignored — pages handle their own error states */ }
  }, [slug])

  useEffect(() => {
    if (!isAppPage) load()
  }, [isAppPage, load])

  if (isAppPage) return <>{children}</>

  const base = `/dashboard/projects/${slug}`
  const isSettings = pathname.startsWith(`${base}/settings`)

  return (
    <div className="flex flex-col gap-6">
      <div>
        {project
          ? <h1 className="text-xl font-semibold mb-4">{project.name}</h1>
          : <Skeleton className="h-7 w-48 mb-4" />
        }
        <TabNavigation tabs={[
          { label: "Overview", href: base, active: !isSettings },
          { label: "Settings", href: `${base}/settings`, active: isSettings },
        ]} />
      </div>
      {children}
    </div>
  )
}
