import { cn } from "@/lib/utils"

/**
 * Always-dark terminal surface for log and manifest output — matches the
 * design's log viewer regardless of the active theme.
 */
export function Terminal({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg bg-[#111113] ring-1 ring-inset ring-[#2e3135] px-4 py-3.5",
        "font-mono text-xs leading-relaxed text-[#c8ccd2]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
