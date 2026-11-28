"use client"

import { useTransition } from "react"
import { ChevronRight, Eye, KeyRound, Pencil, Trash2, type LucideIcon } from "lucide-react"
import { CanetteLogo } from "@/components/canette-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { authorizeAction, denyAction } from "./actions"

type PermissionGroup = {
  id: string
  icon: LucideIcon
  // Always visible. It must be honest on its own: a user who expands nothing
  // still has to know what they grant, including anything destructive.
  summary: string
  // Shown when the group is expanded. It only adds detail to the summary.
  details: string[]
}

// Everything a token lets an MCP client do, ordered by impact. Keep in sync with
// the MCP tools in apps/api/src/services/mcp/tools/ (registered in
// apps/api/src/services/mcp/registry.ts): a user must never grant more than this
// says. A new tool normally extends a group's details; add a group only for a
// new class of risk. Tool modules by group:
//   view:    projects (list_*), status, deployments (list/get), env (list),
//            volumes (list), apps (list_git_credentials), access (get_webhook)
//   change:  projects (create/update), apps, deployments (trigger/redeploy/stop),
//            access (enable/disable_webhook)
//   delete:  env (set/delete), volumes (create/update/delete)
//   secrets: env (request_secret), access (*_password_protection)
// The docs tools read public documentation only and need no line here.
//
// The grant is all-or-nothing: these are not selectable scopes, so nothing on
// this screen may look like a checkbox.
const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "view",
    icon: Eye,
    summary: "See your teams, projects, apps, deployments, logs and metrics",
    details: [
      "Deployment status, build logs, runtime logs and metrics",
      "Environment variable values",
      "Names of secrets and Git credentials, never their values",
    ],
  },
  {
    id: "change",
    icon: Pencil,
    summary: "Create and configure projects and apps, deploy, roll back and stop them",
    details: [
      "Change project and app settings",
      "Trigger deployments and roll back to earlier ones",
      "Stop apps, without deleting them or their data",
      "Turn deploy on Git push on and off, without seeing webhook secrets",
    ],
  },
  {
    id: "delete",
    icon: Trash2,
    summary: "Delete environment variables and app volumes",
    details: [
      "Add, change and delete environment variables",
      "Add, change and delete app volumes",
      "Persistent volumes, and the data in them, can only be deleted by you",
    ],
  },
  {
    id: "secrets",
    icon: KeyRound,
    summary: "Never sees secret values. It can ask you to enter them on a canette page",
    details: [
      "Ask you to enter secret values yourself",
      "Ask you to set, change or remove an app's password protection yourself",
    ],
  },
]

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

// Where the authorization code is sent after the user clicks Authorize — the
// one thing on this screen the client cannot fake. Returns null for a
// redirect_uri that isn't a usable http(s) URL.
function describeDestination(redirectUri: string): { origin: string; loopback: boolean } | null {
  try {
    const url = new URL(redirectUri)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return { origin: url.origin, loopback: LOOPBACK_HOSTS.has(url.hostname) }
  } catch {
    return null
  }
}

function PermissionRow({ group }: { group: PermissionGroup }) {
  const Icon = group.icon
  return (
    <Collapsible asChild>
      <li className="group/perm bg-panel-soft">
        <CollapsibleTrigger className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring">
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-foreground">
            <Icon className="size-3.5" aria-hidden />
          </span>
          <span className="flex-1 pt-0.5 text-foreground">{group.summary}</span>
          <ChevronRight
            className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/perm:rotate-90"
            aria-hidden
          />
          <span className="sr-only">Details</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex flex-col gap-1 pb-2.5 pl-12 pr-3 text-xs text-muted-foreground">
            {group.details.map((d) => (
              <li key={d} className="flex items-start gap-2">
                <span aria-hidden>·</span>
                {d}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

export function ConsentScreen({
  clientName,
  qs,
  redirectUri,
}: {
  clientName: string
  qs: string
  redirectUri: string
}) {
  const [authorizing, startAuthorize] = useTransition()
  const [denying, startDeny] = useTransition()
  const destination = describeDestination(redirectUri)

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm sm:max-w-lg">
        <CardHeader className="text-center gap-1.5">
          <div className="flex justify-center">
            <CanetteLogo className="size-10 p-0.5" />
          </div>
          <CardTitle className="text-lg font-semibold leading-snug">
            {clientName} wants to access canette
          </CardTitle>
          <CardDescription>
            This will allow it to act on your behalf. The name above is what the app calls itself;
            canette can&apos;t verify it.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p id="consent-permissions" className="text-sm font-medium text-foreground">
              It will be able to:
            </p>
            <ul
              aria-labelledby="consent-permissions"
              className="flex flex-col divide-y divide-border rounded-md ring-1 ring-inset ring-border overflow-hidden"
            >
              {PERMISSION_GROUPS.map((g) => (
                <PermissionRow key={g.id} group={g} />
              ))}
            </ul>
          </div>

          {destination?.loopback ? (
            <p className="text-xs text-muted-foreground">
              Access will be sent to an app on this computer:{" "}
              <span className="font-mono text-foreground break-all">{destination.origin}</span>
            </p>
          ) : (
            <div className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-text">
              {destination ? (
                <>
                  <p className="font-medium">Access will be sent to another site:</p>
                  <p className="mt-1 font-mono text-xs break-all">{destination.origin}</p>
                  <p className="mt-2">
                    Only continue if you started this yourself and recognise this address.
                  </p>
                </>
              ) : (
                <p className="font-medium">
                  This request has no valid return address and can&apos;t be authorized.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <form action={denyAction} onSubmit={() => startDeny(() => {})}>
              <input type="hidden" name="qs" value={qs} />
              <Button
                type="submit"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={authorizing || denying}
              >
                {denying ? "Cancelling…" : "Cancel"}
              </Button>
            </form>

            <form action={authorizeAction} onSubmit={() => startAuthorize(() => {})}>
              <input type="hidden" name="qs" value={qs} />
              <Button
                type="submit"
                className="w-full sm:w-auto"
                disabled={!destination || authorizing || denying}
              >
                {authorizing ? "Authorizing…" : "Authorize"}
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
