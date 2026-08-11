import * as React from "react"
import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex w-full rounded-md border border-input bg-field px-3 py-2 text-sm transition-colors",
        "placeholder:text-tertiary",
        "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-accent-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "resize-y min-h-[80px]",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
)
Textarea.displayName = "Textarea"

export { Textarea }
