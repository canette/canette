"use client"

import { cn } from "@/lib/utils"

/** The design's pill-style single-select picker: muted track, raised active segment. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean }>
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={cn("flex gap-0.5 p-0.5 rounded-md bg-muted w-fit", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-3 py-1 rounded-sm text-[12.5px] font-medium transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring",
            o.value === value
              ? "bg-popover text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
