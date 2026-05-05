"use client"

import { useTransition } from "react"
import { CanetteLogo } from "@/components/canette-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { authorizeAction, denyAction } from "./actions"

const TOOL_DESCRIPTIONS = [
  "List and create projects and apps",
  "Trigger deployments",
  "Read deployment status and build logs",
]

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

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CanetteLogo className="size-16 p-1" />
          </div>
          <CardTitle className="text-lg font-semibold leading-snug">
            {clientName} wants to access canette
          </CardTitle>
          <CardDescription>
            This will allow <strong>{clientName}</strong> to act on your behalf.
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

          <Separator />

          <form
            action={authorizeAction}
            onSubmit={() => startAuthorize(() => {})}
            className="contents"
          >
            <input type="hidden" name="qs" value={qs} />
            <Button type="submit" className="w-full" disabled={authorizing || denying}>
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
