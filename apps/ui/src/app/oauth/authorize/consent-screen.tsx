"use client"

import { useTransition } from "react"
import { CanetteLogo } from "@/components/canette-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { authorizeAction, denyAction } from "./actions"

// Everything a token lets an MCP client do. Keep in sync with TOOLS in
// apps/api/src/services/mcp.ts — a user must never grant more than this says.
const TOOL_DESCRIPTIONS = [
  "List and create projects and apps, and change app settings",
  "Trigger deployments and roll back to earlier ones",
  "Read deployment status, build logs, runtime logs and metrics",
  "Read, change and delete environment variables",
  "See the names of secrets and Git credentials, never their values",
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

export function ConsentScreen({
  clientName,
  qs,
  redirectUri,
  state,
}: {
  clientName: string
  qs: string
  redirectUri: string
  state: string
}) {
  const [authorizing, startAuthorize] = useTransition()
  const [denying, startDeny] = useTransition()
  const destination = describeDestination(redirectUri)

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm sm:max-w-lg">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
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
          <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <p className="font-medium mb-2 text-foreground">It will be able to:</p>
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {TOOL_DESCRIPTIONS.map((d) => (
                <li key={d} className="flex items-start gap-2">
                  <span className="mt-0.5 text-foreground">·</span>
                  {d}
                </li>
              ))}
            </ul>
          </div>

          {destination?.loopback ? (
            <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <p>Access will be sent to an app on this computer:</p>
              <p className="mt-1 font-mono text-xs text-foreground break-all">{destination.origin}</p>
            </div>
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

          <Separator />

          <form
            action={authorizeAction}
            onSubmit={() => startAuthorize(() => {})}
            className="contents"
          >
            <input type="hidden" name="qs" value={qs} />
            <Button type="submit" className="w-full" disabled={!destination || authorizing || denying}>
              {authorizing ? "Authorizing…" : "Authorize"}
            </Button>
          </form>

          <form
            action={denyAction}
            onSubmit={() => startDeny(() => {})}
            className="contents"
          >
            <input type="hidden" name="redirect_uri" value={redirectUri} />
            <input type="hidden" name="state" value={state} />
            <Button
              type="submit"
              variant="outline"
              className="w-full"
              disabled={authorizing || denying}
            >
              {denying ? "Cancelling…" : "Cancel"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
