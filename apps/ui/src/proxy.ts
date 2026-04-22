import { type NextRequest, NextResponse } from "next/server"

// better-auth uses "better-auth.session_token" over HTTP and
// "__Secure-better-auth.session_token" over HTTPS (secure prefix added automatically).
const SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"]

const PROTECTED_PREFIXES = ["/dashboard", "/admin"]
const AUTH_PREFIXES = ["/login"]

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Proxy API calls - regardless of session
  const isApi = pathname.startsWith("/api/")
  if (isApi) {
    const apiUrl = process.env.API_URL ?? "http://localhost:3001"
    const path = request.nextUrl.pathname + request.nextUrl.search
    return NextResponse.rewrite(`${apiUrl}${path}`)
  }

  // Only check existence — real validation happens in the API on every request.
  const hasSession = SESSION_COOKIES.some((name) => !!request.cookies.get(name)?.value)

  // Smart redirect from root based on session cookie
  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(hasSession ? "/dashboard" : "/login", request.url),
    )
  }

  // Block unauthenticated access to protected routes
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))
  if (isProtected && !hasSession) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("next", pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Redirect already-authenticated users away from auth pages
  const isAuthPage = AUTH_PREFIXES.some((p) => pathname.startsWith(p))
  if (isAuthPage && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }

  return NextResponse.next()
}

export const config = {
  // Run on all routes except Next.js internals and static assets.
  // The /api prefix is intentionally excluded — those requests go straight
  // to the backend proxy and are authenticated there.
  // Exclude only Next.js internals and static assets.
  // /api/* is intentionally included so the proxy rewrite runs for API calls.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|healthz|.*\\.(?:png|svg|ico|webp)).*)",
  ],
}
