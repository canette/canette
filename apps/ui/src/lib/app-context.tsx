"use client"

import { createContext, useContext } from "react"
import type { App, Project } from "@canette/types"

interface AppContextValue {
  app: App
  project: Project
  refresh: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

export const AppProvider = AppContext.Provider

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useAppContext called outside app layout")
  return ctx
}
