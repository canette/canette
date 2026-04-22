// Root page — the middleware handles the smart redirect (→ /dashboard when a
// session cookie is present, → /login otherwise). This server-side redirect is
// a fallback in case the middleware does not run (e.g. during static export).
import { redirect } from "next/navigation"

export default function RootPage() {
  redirect("/login")
}
