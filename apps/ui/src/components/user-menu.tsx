"use client"

import * as Avatar from "@radix-ui/react-avatar"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { signOut } from "@/lib/auth-client"
import { useCurrentUser } from "@/lib/session-context"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function UserMenu() {
  const router = useRouter()
  const user = useCurrentUser()

  const isAdmin = user.role === "admin"

  async function handleSignOut() {
    await signOut()
    router.push("/login")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Avatar.Root
          className="relative flex items-center justify-center h-8 w-8 rounded-md bg-muted hover:bg-muted/80 border border-border overflow-hidden transition-colors cursor-pointer"
          aria-label="User menu"
        >
          <Avatar.Image
            src={user.image ?? undefined}
            alt={user.name}
            className="h-full w-full object-cover"
          />
          <Avatar.Fallback className="flex items-center justify-center h-full w-full text-xs font-semibold">
            {initials(user.name)}
          </Avatar.Fallback>
        </Avatar.Root>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <p className="text-sm font-medium truncate">{user.name}</p>
          <p className="text-xs text-muted-foreground truncate">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/dashboard/settings/profile">Profile</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/teams">Teams</Link>
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
