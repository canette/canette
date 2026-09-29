"use client"

import { useState } from "react"
import { Eye, EyeOff, WrapText } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const PEM_HEADER = "-----BEGIN"

type EnvValueFieldProps = {
  value: string
  onChange: (value: string) => void
  isSecret: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  /** Fires on Enter while in single-line mode — used by "add row" forms to submit. */
  onEnter?: () => void
  /** Notified whenever multi-line mode toggles, so a parent row can re-flow its layout. */
  onMultilineChange?: (multiline: boolean) => void
}

/**
 * Value input for an env var or secret. Defaults to a single-line field;
 * a toggle switches to a resizable Textarea for pasting multi-line values
 * (certs, private keys, JSON) — auto-switches on paste/type if the value
 * looks like a PEM block.
 */
export function EnvValueField({
  value,
  onChange,
  isSecret,
  placeholder,
  className,
  autoFocus,
  onEnter,
  onMultilineChange,
}: EnvValueFieldProps) {
  const [multiline, setMultiline] = useState(() => value.includes(PEM_HEADER))
  const [showSecret, setShowSecret] = useState(false)

  function updateMultiline(next: boolean) {
    setMultiline(next)
    onMultilineChange?.(next)
  }

  function handleChange(next: string) {
    if (!multiline && next.includes(PEM_HEADER)) updateMultiline(true)
    onChange(next)
  }

  return (
    <div className={cn("flex flex-1 items-center gap-2", multiline && "flex-col items-stretch")}>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className={cn("font-mono text-xs min-h-[100px]", className)}
          autoFocus={autoFocus}
        />
      ) : (
        <Input
          type={isSecret && !showSecret ? "password" : "text"}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className={cn("font-mono text-xs", className)}
          autoFocus={autoFocus}
          onKeyDown={(e) => { if (e.key === "Enter") onEnter?.() }}
        />
      )}
      <div className={cn("flex items-center gap-1.5 shrink-0", multiline && "self-end")}>
        {isSecret && (
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showSecret ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => updateMultiline(!multiline)}
          className={cn("text-muted-foreground hover:text-foreground", multiline && "text-foreground")}
          tabIndex={-1}
          aria-label={multiline ? "Switch to single-line" : "Switch to multi-line"}
          title={multiline ? "Switch to single-line" : "Switch to multi-line"}
        >
          <WrapText size={15} />
        </button>
      </div>
    </div>
  )
}
