import Link from "next/link"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { GitCredential, GitProvider } from "@canette/types"

function detectProvider(gitUrl: string): GitProvider | null {
  try {
    const normalized = gitUrl.includes("://") ? gitUrl : `https://${gitUrl}`
    const host = new URL(normalized).hostname.toLowerCase()
    if (host === "github.com" || host.endsWith(".github.com")) return "github"
    if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.includes("gitlab")) return "gitlab"
    if (host.includes("gitea")) return "gitea"
    return null
  } catch {
    return null
  }
}

interface Props {
  credentials: GitCredential[]
  value: string
  onChange: (value: string) => void
  teamId?: string
  gitUrl?: string
  id?: string
}

export function CredentialSelect({ credentials, value, onChange, teamId, gitUrl, id = "gitCredentialId" }: Props) {
  const detectedProvider = gitUrl?.trim() ? detectProvider(gitUrl) : null

  const matching = detectedProvider
    ? credentials.filter((c) => c.provider === detectedProvider)
    : []
  const others = detectedProvider
    ? credentials.filter((c) => !matching.includes(c))
    : credentials

  function credItem(c: GitCredential) {
    return (
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
    )
  }

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
          {detectedProvider && matching.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel className="text-xs font-normal text-muted-foreground">Suggested</SelectLabel>
                {matching.map(credItem)}
              </SelectGroup>
              {others.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel className="text-xs font-normal text-muted-foreground">Other</SelectLabel>
                    {others.map(credItem)}
                  </SelectGroup>
                </>
              )}
            </>
          ) : (
            credentials.map(credItem)
          )}
        </SelectContent>
      </Select>
      {credentials.length === 0 && (
        <p className="text-xs text-muted-foreground">
          For private repos,{" "}
          <Link
            href={teamId ? `/dashboard/teams/${teamId}/credentials` : "/dashboard/teams"}
            className="underline underline-offset-2 hover:text-foreground"
          >
            add a credential
          </Link>{" "}
          first.
        </p>
      )}
    </div>
  )
}
