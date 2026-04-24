"use client"

import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { href: "/dashboard/settings/profile", label: "Profile" },
]

export function SettingsNav() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ href, label }) => (
        <a
          key={href}
          href={href}
          className={cn(
            "rounded-md px-3 py-2 text-sm transition-colors",
            pathname === href
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}
