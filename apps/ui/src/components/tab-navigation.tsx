import Link from "next/link"
import { cn } from "@/lib/utils"

export interface TabItem {
  label: string
  href: string
  active: boolean
}

export function TabNavigation({ tabs }: { tabs: TabItem[] }) {
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
