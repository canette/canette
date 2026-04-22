"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function InstallPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/docs/getting-started/installation")
  }, [router])
  return null
}
