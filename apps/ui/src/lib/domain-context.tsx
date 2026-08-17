"use client"

import { createContext, useContext, useEffect, useState } from "react"
import * as api from "@/lib/api"

// undefined = outside provider, null = still loading, string = loaded (possibly "")
const DomainContext = createContext<string | null | undefined>(undefined)

export function DomainProvider({ children }: { children: React.ReactNode }) {
  const [domain, setDomain] = useState<string | null>(null)

  useEffect(() => {
    api.config.get()
      .then((r) => setDomain(r.domain))
      .catch(() => setDomain(""))
  }, [])

  return <DomainContext.Provider value={domain}>{children}</DomainContext.Provider>
}

/** Returns the platform base domain, or null while it's still loading. Only call inside the authenticated layout tree. */
export function useDomain(): string | null {
  const domain = useContext(DomainContext)
  if (domain === undefined) throw new Error("useDomain called outside DomainProvider")
  return domain
}
