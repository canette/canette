import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { GitCredential } from "@canette/types"

interface Props {
  credentials: GitCredential[]
  value: string        // "" means "no credential"
  onChange: (value: string) => void
  id?: string
}

export function CredentialSelect({ credentials, value, onChange, id = "gitCredentialId" }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Credential</Label>
      <Select
        value={value || "__none__"}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="No credentials — public repo" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No credentials — public repo</SelectItem>
          {credentials.map((c) => (
            <SelectItem key={c.id} value={c.id} textValue={c.name}>
              <span className="flex items-center gap-2">
                {c.name}
                {c.type === "github_app" && (
                  <Badge variant="secondary" className="text-xs font-normal">GitHub App</Badge>
                )}
                {c.teamId === null && (
                  <Badge variant="secondary" className="text-xs font-normal">system</Badge>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
