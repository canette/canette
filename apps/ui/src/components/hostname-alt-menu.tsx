"use client"

import { ChevronDown, ExternalLink } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AppHostname } from "@canette/types"

// Small "+N" trigger listing every additional hostname assigned to an app,
// alongside the platform-generated URL shown next to it. Renders nothing when
// there are no extra hostnames — the primary URL link stands alone as today.
export function HostnameAltMenu({ primaryUrl, hostnames }: { primaryUrl: string; hostnames: AppHostname[] }) {
  if (hostnames.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          title={`${hostnames.length} additional hostname${hostnames.length !== 1 ? "s" : ""}`}
        >
          +{hostnames.length}
          <ChevronDown size={9} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Hostnames</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={primaryUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 font-mono">
            <span className="truncate">{primaryUrl.replace(/^https?:\/\//, "")}</span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
              default <ExternalLink size={10} />
            </span>
          </a>
        </DropdownMenuItem>
        {hostnames.map((h) => (
          <DropdownMenuItem key={h.id} asChild>
            <a href={`https://${h.hostname}`} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 font-mono">
              <span className="truncate">{h.hostname}</span>
              <ExternalLink size={10} className="text-muted-foreground shrink-0" />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
