import { redirect } from "next/navigation"

// Credentials are now managed per-team. Redirect to the teams page.
export default function CredentialsRedirect() {
  redirect("/dashboard/teams")
}
