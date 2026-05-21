import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-white",
        outline: "text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        live: "border-transparent bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400",
        building: "border-transparent bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400",
        deploying: "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
        failed: "border-transparent bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
        pending: "border-transparent bg-zinc-100 text-zinc-500 dark:bg-zinc-500/15 dark:text-zinc-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
