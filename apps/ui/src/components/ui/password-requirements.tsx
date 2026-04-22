import { Check, X } from "lucide-react"
import { PASSWORD_REQUIREMENTS } from "@/lib/password"

export function PasswordRequirements({ password }: { password: string }) {
  if (!password) return null
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {PASSWORD_REQUIREMENTS.map((req) => {
        const met = req.test(password)
        return (
          <li
            key={req.label}
            className={`flex items-center gap-1.5 ${met ? "text-green-600" : "text-muted-foreground"}`}
          >
            {met ? <Check className="size-3" /> : <X className="size-3" />}
            {req.label}
          </li>
        )
      })}
    </ul>
  )
}
