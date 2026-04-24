"use client"

import { signOut } from "@/lib/auth-client"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

export function LogoutButton() {
  const router = useRouter()
  return (
    <Button variant="ghost" size="sm" onClick={() => signOut().then(() => router.push("/login"))}>
      Sign out
    </Button>
  )
}
