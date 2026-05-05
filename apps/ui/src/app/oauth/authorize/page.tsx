import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { ConsentScreen } from "./consent-screen"

export const dynamic = "force-dynamic"

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams(params).toString()
  const selfPath = `/oauth/authorize?${qs}`

  const cookieStore = await cookies()
  const sessionToken =
    cookieStore.get("better-auth.session_token")?.value ??
    cookieStore.get("__Secure-better-auth.session_token")?.value

  if (!sessionToken) {
    redirect(`/login?callbackURL=${encodeURIComponent(selfPath)}`)
  }

  // Resolve the registered client name for display. Falls back to "An MCP
  // client" if the registration was lost on a server restart.
  let clientName = "An MCP client"
  const clientId = params.client_id
  if (clientId) {
    const apiUrl = process.env.API_URL ?? "http://localhost:3001"
    try {
      const res = await fetch(`${apiUrl}/oauth/clients/${clientId}`)
      if (res.ok) {
        const data = (await res.json()) as { clientName: string | null }
        if (data.clientName) clientName = data.clientName
      }
    } catch {
      // ignore — use fallback name
    }
  }

  return (
    <ConsentScreen
      clientName={clientName}
      qs={qs}
      redirectUri={params.redirect_uri ?? ""}
      state={params.state ?? ""}
    />
  )
}
