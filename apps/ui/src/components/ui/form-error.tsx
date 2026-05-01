import { AlertCircle } from "lucide-react"

export function FormError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="size-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
