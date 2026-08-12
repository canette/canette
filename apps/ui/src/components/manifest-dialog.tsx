"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Terminal } from "@/components/ui/terminal"
import { Download, X } from "lucide-react"
import * as api from "@/lib/api"

export function ManifestDialog({ deploymentId, onClose }: { deploymentId: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.deployments.manifest(deploymentId).then((r) => setManifest(r.manifest)).catch(() => setManifest(null)).finally(() => setLoading(false))
  }, [deploymentId])

  function handleDownload() {
    if (!manifest) return
    const blob = new Blob([manifest], { type: "application/yaml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `manifest-${deploymentId}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl" aria-describedby={undefined}>
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="text-sm">Applied manifest</DialogTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleDownload} disabled={!manifest} className="h-7 w-7" title="Download manifest">
            <Download size={14} />
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7"><X size={14} /></Button>
          </DialogClose>
        </div>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <Terminal className="min-h-full">
          {loading ? <Skeleton className="h-4 w-32" />
            : manifest === null ? <span className="text-[#777b84]">Manifest not available.</span>
              : <pre className="whitespace-pre-wrap">{manifest}</pre>}
        </Terminal>
      </div>
    </DialogContent>
  )
}
