"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import type { Project } from "@canette/types"

function ProjectTabs({ slug }: { slug: string }) {
  const pathname = usePathname()
  const base = `/dashboard/projects/${slug}`
  const isSettings = pathname.startsWith(`${base}/settings`)

  const tabs = [
    { label: "Overview", href: base, active: !isSettings },
    { label: "Settings", href: `${base}/settings`, active: isSettings },
  ]

  return (
    <nav className="flex border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            "px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
            tab.active
              ? "border-foreground text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { slug } = useParams<{ slug: string }>()
  const pathname = usePathname()
  const [project, setProject] = useState<Project | null>(null)

  // App-level pages have their own layout/tabs — pass through without wrapping.
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        {project && <h1 className="text-xl font-semibold mb-4">{project.name}</h1>}
        <ProjectTabs slug={slug} />
      </div>
      {children}
    </div>
  )
}
