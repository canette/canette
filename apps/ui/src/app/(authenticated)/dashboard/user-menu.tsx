"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { useSession, signOut } from "@/lib/auth-client"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

// Runtime type guard for the extended session user shape (better-auth does not
// expose the `role` field in its default TS types unless the server plugin is
// configured with the matching client plugin).
interface AppUser {
  name: string
  email: string
  image?: string | null
  role?: string
}

function isAppUser(u: unknown): u is AppUser {
  return (
    typeof u === "object" &&
    u !== null &&
    typeof (u as Record<string, unknown>).name === "string" &&
    typeof (u as Record<string, unknown>).email === "string"
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function UserMenu() {
  const router = useRouter()
  const { data: session } = useSession()

  const rawUser = session?.user
  const user = isAppUser(rawUser) ? rawUser : undefined
  const isAdmin = user?.role === "admin"

  async function handleSignOut() {
    await signOut()
    router.push("/login")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex items-center justify-center h-8 w-8 rounded-full bg-muted hover:bg-muted/80 border border-border text-xs font-semibold overflow-hidden transition-colors"
          aria-label="User menu"
        >
          {user?.image ? (
            // next/image validates the URL against remotePatterns in next.config.ts,
            // preventing arbitrary external image sources.
            <Image
              src={user.image}
              alt={user.name}
              width={32}
              height={32}
              className="h-full w-full object-cover"
            />
          ) : (
            <span>{user ? initials(user.name) : "…"}</span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {user && (
          <>
            <DropdownMenuLabel>
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <a href="/dashboard/settings/profile">Profile</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/dashboard/settings/credentials">Settings</a>
        </DropdownMenuItem>
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/admin">Admin</a>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleSignOut}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
