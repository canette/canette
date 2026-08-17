"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function StopAppDialog({ onConfirm, onClose, stopping }: { onConfirm: () => void; onClose: () => void; stopping: boolean }) {
  const [confirmed, setConfirmed] = useState(false)
  return (
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>Stop app?</DialogTitle></DialogHeader>
      <div className="px-6 pb-6 flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">This will terminate the running deployment. The app will be unavailable until you redeploy.</p>
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} />
          <span className="text-sm">Yes, stop this app</span>
        </label>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={!confirmed || stopping} onClick={onConfirm}>
            {stopping ? "Stopping…" : "Stop app"}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}
