"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import type { Team } from "@canette/types"

function TeamTabs({ id }: { id: string }) {
  const pathname = usePathname()
  const base = `/dashboard/teams/${id}`
  const tabs = [
    { label: "Members", href: `${base}/members`, active: pathname.startsWith(`${base}/members`) },
    { label: "Credentials", href: `${base}/credentials`, active: pathname.startsWith(`${base}/credentials`) },
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

export default function TeamLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const [team, setTeam] = useState<Team | null>(null)

  const load = useCallback(async () => {
    try {
      const t = await api.teams.get(id)
      setTeam(t)
    } catch { /* pages handle their own error states */ }
  }, [id])

  useEffect(() => { load() }, [load])

  return (
    <div className="flex flex-col gap-6">
      <div>
        {team && (
          <h1 className="text-xl font-semibold mb-4">
            {team.isPersonal ? "Personal" : team.name}
          </h1>
        )}
        <TeamTabs id={id} />
      </div>
      {children}
    </div>
  )
}
