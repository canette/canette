"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { changePassword } from "@/lib/auth-client"
import * as api from "@/lib/api"
import type { User } from "@canette/types"
import { PasswordRequirements } from "@/components/ui/password-requirements"
import { validatePassword } from "@/lib/password"

// Header and layout are provided by settings/layout.tsx

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Name form
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  // Password form
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState("")
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  useEffect(() => {
    api.users.me()
      .then((u) => { setUser(u); setName(u.name) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!user || !name.trim() || name === user.name) return
    setSaveError("")
    setSaving(true)
    try {
      const updated = await api.users.updateMe({ name: name.trim() })
      setUser(updated)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError("")
    setPasswordSuccess(false)
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match")
      return
    }
    setChangingPassword(true)
    try {
      const result = await changePassword({ currentPassword, newPassword })
      if (result.error) {
        setPasswordError(result.error.message ?? "Failed to change password")
        return
      }
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setPasswordSuccess(true)
    } catch (e: unknown) {
      setPasswordError(e instanceof Error ? e.message : "Failed to change password")
    } finally {
      setChangingPassword(false)
    }
  }

  const isDirty = user && name !== user.name

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Profile</h1>
      </div>

      {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {user && (
        <div className="flex flex-col gap-6">
            {/* Account details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Account</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSave} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Email</Label>
                    <p className="text-sm text-muted-foreground py-1">{user.email}</p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Role</Label>
                    <div>
                      <Badge variant={user.role === "admin" ? "live" : "secondary"}>
                        {user.role}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label>Member since</Label>
                    <p className="text-sm text-muted-foreground py-1">
                      {new Date(user.createdAt).toLocaleDateString(undefined, {
                        year: "numeric", month: "long", day: "numeric",
                      })}
                    </p>
                  </div>

                  {saveError && <p className="text-sm text-destructive">{saveError}</p>}

                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={!isDirty || saving}>
                      {saving ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* Change password — only for email/password accounts */}
            {user.hasPassword && <Card>
              <CardHeader>
                <CardTitle className="text-base">Change password</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleChangePassword} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="currentPassword">Current password</Label>
                    <Input
                      id="currentPassword"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </div>

                  <Separator />

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="newPassword">New password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                    <PasswordRequirements password={newPassword} />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="confirmPassword">Confirm new password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>

                  {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
                  {passwordSuccess && <p className="text-sm text-green-600">Password updated successfully.</p>}

                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!currentPassword || !newPassword || !confirmPassword || changingPassword || validatePassword(newPassword).length > 0}
                    >
                      {changingPassword ? "Updating…" : "Update password"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>}
        </div>
      )}
    </div>
  )
}
