"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

export async function authorizeAction(formData: FormData) {
  const qs = formData.get("qs") as string
  const cookieStore = await cookies()
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ")

  const apiUrl = process.env.API_URL ?? "http://localhost:3001"
  let location: string | null = null
  try {
    const res = await fetch(`${apiUrl}/oauth/confirm?${qs}`, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieHeader },
    })
    location = res.headers.get("location")
  } catch {
    // fall through
  }

  if (location) {
    redirect(location)
  }

  // Session expired between consent render and submit — send back to login.
  redirect(`/login?callbackURL=${encodeURIComponent(`/oauth/authorize?${qs}`)}`)
}

// The API validates redirect_uri (http(s), registered for the client) before
// redirecting, the same as on Authorize. The consent page can be linked to
// directly, so redirecting to the form's redirect_uri here would be an open
// redirect. Anything the API rejects lands on the dashboard instead.
export async function denyAction(formData: FormData) {
  const qs = formData.get("qs") as string

  const apiUrl = process.env.API_URL ?? "http://localhost:3001"
  let location: string | null = null
  try {
    const res = await fetch(`${apiUrl}/oauth/deny?${qs}`, {
      method: "POST",
      redirect: "manual",
    })
    location = res.headers.get("location")
  } catch {
    // fall through
  }

  // redirect() throws NEXT_REDIRECT, so it must stay outside the try/catch.
  redirect(location ?? "/dashboard")
}
