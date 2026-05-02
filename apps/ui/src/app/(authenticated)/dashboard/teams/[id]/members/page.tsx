"use client"

import { useEffect, useState, use } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { useSession } from "@/lib/auth-client"
import * as api from "@/lib/api"
import type { Team, TeamMember } from "@canette/types"

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return "today"
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = use(params)
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === "admin"

  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.teams.get(teamId)
      .then((data) => { setTeam(data); setMembers(data.members) })
      .finally(() => setLoading(false))
  }, [teamId])

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (!team) return <p className="text-muted-foreground text-sm">Team not found.</p>

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Members
            {team.isPersonal && <Badge variant="secondary" className="text-xs font-normal">personal team</Badge>}
          </CardTitle>
          <CardDescription>
            {team.isPersonal
              ? "Your personal team — for your personal projects. You are the only member."
              : "All members have full access to this team's projects and apps."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!team.isPersonal && members.length > 0 && (
            <>
              <div className="px-6 py-1.5 flex items-center gap-4 border-b border-border/50">
                <span className="text-xs text-muted-foreground uppercase flex-1">Name / Email</span>
                <span className="text-xs text-muted-foreground uppercase text-right w-20">Joined</span>
              </div>
              {members.map((member, i) => (
                <div key={member.userId}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center gap-4 px-6 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{member.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                    </div>
                    <span className="text-xs text-muted-foreground text-right w-20">{timeAgo(member.joinedAt)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
          {!team.isPersonal && isAdmin && (
            <p className="text-xs text-muted-foreground px-6 py-3 border-t border-border/50">
              Manage members in <a href="/admin/teams" className="underline hover:text-foreground">Admin → Teams</a>.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
