import Link from "next/link"
import { ArrowUpRight, Container, GitBranch, LayoutTemplate, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type SourceChooserValue = "git" | "image" | "template"

const CARDS: Array<{ value: SourceChooserValue; label: string; description: string; icon: LucideIcon }> = [
  { value: "git", label: "Git repository", description: "Build and deploy from a branch.", icon: GitBranch },
  { value: "image", label: "Docker image", description: "Deploy a prebuilt image from a registry.", icon: Container },
  { value: "template", label: "From template", description: "Set up several apps at once from a template file.", icon: LayoutTemplate },
]

const cardBase =
  "flex w-full flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
const unselected = "border-border hover:border-border-strong"
const selected = "border-primary ring-1 ring-inset ring-primary"

function IconTile({ Icon, active }: { Icon: LucideIcon; active: boolean }) {
  return (
    <div
      className={cn(
        "size-8 rounded-md flex items-center justify-center shrink-0",
        active ? "bg-accent-soft text-accent-text" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon size={16} />
    </div>
  )
}

type SourceChooserProps = {
  value: SourceChooserValue
  // Only invoked for the "git"/"image" cards — "template" is always a navigation (see hrefs).
  onChange?: (value: "git" | "image") => void
  // Cards with an href navigate instead of selecting; omit a key to make that
  // card the current, non-interactive state (used for "template" on its own page).
  hrefs?: Partial<Record<SourceChooserValue, string>>
  className?: string
}

export function SourceChooser({ value, onChange, hrefs, className }: SourceChooserProps) {
  return (
    <fieldset className={cn("flex flex-col border-0 p-0 m-0", className)}>
      <legend className="text-sm font-medium px-0 mb-2">Source</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {CARDS.map((card) => {
          const active = value === card.value
          const href = hrefs?.[card.value]
          const body = (
            <>
              <IconTile Icon={card.icon} active={active} />
              <span className="text-sm font-medium flex items-center gap-1">
                {card.label}
                {href && <ArrowUpRight className="size-3.5 text-muted-foreground" />}
              </span>
              <span className="text-xs text-muted-foreground">{card.description}</span>
            </>
          )

          if (href) {
            return (
              <Link key={card.value} href={href} className={cn(cardBase, active ? selected : unselected)}>
                {body}
              </Link>
            )
          }

          const cardValue = card.value
          if (cardValue === "template") {
            return (
              <div key={cardValue} className={cn(cardBase, selected, "cursor-default")}>
                {body}
              </div>
            )
          }

          return (
            <button
              key={cardValue}
              type="button"
              aria-pressed={active}
              onClick={() => onChange?.(cardValue)}
              className={cn(cardBase, active ? selected : unselected)}
            >
              {body}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
