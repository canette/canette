"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { SkeletonText } from "@/components/ui/skeleton"
import * as api from "@/lib/api"
import type { Team } from "@canette/types"

export default function TeamsPage() {
  const router = useRouter()
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.teams.list().then(setTeams).finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Teams</h1>
      {loading ? (
        <SkeletonText />
      ) : teams.length === 0 ? (
        <p className="text-muted-foreground text-sm">No teams.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <Card key={team.id} className="cursor-pointer hover:border-foreground/20 transition-colors"
              onClick={() => router.push(`/dashboard/teams/${team.id}`)}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {team.name}
                  {team.isPersonal && <Badge variant="secondary" className="text-xs font-normal">personal</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
