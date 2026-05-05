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

export async function denyAction(formData: FormData) {
  const redirectUri = formData.get("redirect_uri") as string
  const state = formData.get("state") as string | null

  // Build the error URL before calling redirect() — redirect() throws a
  // NEXT_REDIRECT internally, so it must never be inside a try/catch or the
  // catch block intercepts it and swallows the redirect.
  let callbackUrl: string
  try {
    const url = new URL(redirectUri)
    url.searchParams.set("error", "access_denied")
    url.searchParams.set("error_description", "The user denied the authorization request")
    if (state) url.searchParams.set("state", state)
    callbackUrl = url.toString()
  } catch {
    redirect("/dashboard")
  }

  redirect(callbackUrl)
}
