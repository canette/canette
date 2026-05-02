"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, usePathname } from "next/navigation"
import { TabNavigation } from "@/components/tab-navigation"
import * as api from "@/lib/api"
import type { Team } from "@canette/types"

export default function TeamLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const [team, setTeam] = useState<Team | null>(null)

  const load = useCallback(async () => {
    try {
      const t = await api.teams.get(id)
      setTeam(t)
    } catch { /* pages handle their own error states */ }
  }, [id])

  useEffect(() => { load() }, [load])

  const base = `/dashboard/teams/${id}`

  return (
    <div className="flex flex-col gap-6">
      <div>
        {team && (
          <h1 className="text-xl font-semibold mb-4">
            {team.isPersonal ? "Personal" : team.name}
          </h1>
        )}
        <TabNavigation tabs={[
          { label: "Members", href: `${base}/members`, active: pathname.startsWith(`${base}/members`) },
          { label: "Credentials", href: `${base}/credentials`, active: pathname.startsWith(`${base}/credentials`) },
        ]} />
      </div>
      {children}
    </div>
  )
}
