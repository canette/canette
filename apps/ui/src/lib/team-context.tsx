"use client"

import { createContext, useContext, useState, useEffect } from "react"

interface TeamContextValue {
  selectedTeamId: string | null
  setSelectedTeamId: (id: string) => void
}

const TeamContext = createContext<TeamContextValue | null>(null)

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const [selectedTeamId, setSelectedTeamIdState] = useState<string | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem("selected-team")
    if (stored) setSelectedTeamIdState(stored)
  }, [])

  function setSelectedTeamId(id: string) {
    setSelectedTeamIdState(id)
    localStorage.setItem("selected-team", id)
  }

  return (
    <TeamContext.Provider value={{ selectedTeamId, setSelectedTeamId }}>
      {children}
    </TeamContext.Provider>
  )
}

export function useSelectedTeam(): TeamContextValue {
  const ctx = useContext(TeamContext)
  if (!ctx) throw new Error("useSelectedTeam called outside TeamProvider")
  return ctx
}
