"use client"

import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Terminal } from "@/components/ui/terminal"
import { FormError } from "@/components/ui/form-error"
import { Download, Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import { ApiError } from "@/lib/api"
import { shortSha, timeAgo, formatDuration } from "@/lib/deployment-format"
import type { BuildLog, Deployment } from "@canette/types"

type Mode = "build" | "runtime"
type CronRunMeta = { status: "succeeded" | "failed" | "no_runs"; startedAt?: string; finishedAt?: string }

export default function LogsPage() {
  const { app } = useAppContext()
  const searchParams = useSearchParams()
  const isCronJob = app.deploymentType === "cronjob"

  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loadingDeps, setLoadingDeps] = useState(true)
  const [loadDepsError, setLoadDepsError] = useState("")
  const [mode, setMode] = useState<Mode>("build")
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // build mode
  const [logs, setLogs] = useState<BuildLog[]>([])
  const [loadingLogs, setLoadingLogs] = useState(true)

  // runtime mode
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [cronMeta, setCronMeta] = useState<CronRunMeta | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    api.deployments.list(app.id, 20)
      .then((r) => { setDeploymentList(r.items); setLoadDepsError("") })
      .catch((e: unknown) => {
        const status = e instanceof ApiError ? ` (HTTP ${e.status})` : ""
        setLoadDepsError(`Failed to load deployments${status}: ${e instanceof Error ? e.message : "unknown error"}`)
      })
      .finally(() => setLoadingDeps(false))
  }, [app.id])

  // resolve initial mode + selected deployment from query params, once the list is loaded
  useEffect(() => {
    if (initializedRef.current || loadingDeps) return
    initializedRef.current = true
    const qMode = searchParams.get("mode")
    const qDeployment = searchParams.get("deployment")
    const hasLive = deploymentList.some((d) => d.status === "live")
    if (qMode === "runtime" || qMode === "build") setMode(qMode)
    else setMode(qDeployment ? "build" : hasLive ? "runtime" : "build")
    const found = qDeployment && deploymentList.find((d) => d.id === qDeployment)
    setSelectedDeploymentId(found ? found.id : (deploymentList[0]?.id ?? null))
  }, [loadingDeps, deploymentList, searchParams])

  const selectedDeployment = deploymentList.find((d) => d.id === selectedDeploymentId) ?? null
  const isTerminalStatus = selectedDeployment ? ["live", "failed", "stopped"].includes(selectedDeployment.status) : false

  // build mode: fetch + poll
  useEffect(() => {
    if (mode !== "build" || !selectedDeploymentId) return
    let cancelled = false
    async function fetchLogs() {
      try {
        const d = await api.deployments.logs(selectedDeploymentId!)
        if (!cancelled) setLogs(d.items)
      } catch { /* ignore */ } finally {
        if (!cancelled) setLoadingLogs(false)
      }
    }
    setLoadingLogs(true)
    fetchLogs()
    if (isTerminalStatus) return () => { cancelled = true }
    const interval = setInterval(fetchLogs, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [mode, selectedDeploymentId, isTerminalStatus, refreshKey])

  // runtime mode: SSE stream
  useEffect(() => {
    if (mode !== "runtime") {
      setLines([]); setConnected(false); setCronMeta(null)
      return
    }
    const source = api.appLogs.stream(app.id)
    source.onopen = () => setConnected(true)
    source.addEventListener("log", (e) => {
      setLines((prev) => { const next = [...prev, (e as MessageEvent).data]; return next.length > 500 ? next.slice(-500) : next })
    })
    source.addEventListener("meta", (e) => {
      try { setCronMeta(JSON.parse((e as MessageEvent).data)) } catch { /* ignore */ }
    })
    source.onerror = () => { setConnected(false); source.close() }
    source.addEventListener("ping", () => {})
    return () => source.close()
  }, [mode, app.id, refreshKey])

  useEffect(() => {
    if (!userScrolledUp.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    }
  }, [logs, lines])

  function downloadLogs() {
    if (!selectedDeployment) return
    const text = logs.map((l) => l.line).join("\n")
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `build-${shortSha(selectedDeployment.commitSha)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleScroll() {
    const el = scrollRef.current
    if (el) userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48
  }

  if (loadingDeps) {
    return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
  }

  if (loadDepsError) {
    return <FormError message={loadDepsError} />
  }

  if (deploymentList.length === 0) {
    return <p className="text-sm text-muted-foreground">No deployments yet.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <SegmentedControl
            options={[
              { value: "build", label: "Build" },
              { value: "runtime", label: isCronJob ? "Last run" : "Runtime" },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === "build" && (
            <Select value={selectedDeploymentId ?? undefined} onValueChange={setSelectedDeploymentId}>
              <SelectTrigger className="w-[300px] font-mono text-xs h-8">
                <SelectValue placeholder="Select a deployment" />
              </SelectTrigger>
              <SelectContent>
                {deploymentList.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {shortSha(d.commitSha)} — {d.commitMessage || d.status} · {timeAgo(d.createdAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {mode === "build" && selectedDeployment && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
              <span className="text-foreground">{shortSha(selectedDeployment.commitSha)}</span>
              {app.gitBranch && <span>· {app.gitBranch}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mode === "runtime" && !cronMeta && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-tertiary")} />
              {connected ? "Live" : "Connecting…"}
            </span>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={() => setRefreshKey((k) => k + 1)}>
            <RefreshCw size={12} />Refresh
          </Button>
          {mode === "build" && isTerminalStatus && !loadingLogs && logs.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={downloadLogs}>
              <Download size={12} />Download
            </Button>
          )}
        </div>
      </div>

      {mode === "build" && selectedDeployment?.status === "failed" && selectedDeployment.errorMessage && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive mb-1">Deployment failed</p>
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{selectedDeployment.errorMessage}</p>
        </div>
      )}

      {mode === "runtime" && cronMeta && cronMeta.status !== "no_runs" && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground w-fit">
          <span className={cronMeta.status === "succeeded" ? "text-success-text font-medium" : "text-destructive font-medium"}>
            {cronMeta.status === "succeeded" ? "Succeeded" : "Failed"}
          </span>
          {cronMeta.startedAt && <span>{new Date(cronMeta.startedAt).toLocaleString()}</span>}
          {cronMeta.startedAt && cronMeta.finishedAt && <span>{formatDuration(cronMeta.startedAt, cronMeta.finishedAt)}</span>}
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} className="h-[calc(100vh-290px)] min-h-[420px] overflow-y-auto rounded-lg">
        <Terminal className="min-h-full">
          {mode === "build" ? (
            loadingLogs ? (
              <span className="flex items-center gap-2 text-[#777b84]"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Loading logs…</span>
            ) : logs.length === 0 ? (
              !isTerminalStatus
                ? <span className="flex items-center gap-2 text-[#777b84]"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Waiting for logs…</span>
                : <span className="text-[#777b84]">No logs available.</span>
            ) : (
              <pre className="whitespace-pre-wrap">{logs.map((l) => l.line).join("\n")}</pre>
            )
          ) : (
            cronMeta?.status === "no_runs" ? (
              <span className="text-[#777b84]">No runs yet.</span>
            ) : (!connected && !cronMeta) ? (
              <span className="flex items-center gap-2 text-[#777b84]"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />{isCronJob ? "Fetching last run…" : "Connecting…"}</span>
            ) : lines.length === 0 ? (
              <span className="text-[#777b84]">{isCronJob ? "No output." : "No logs yet. They will appear here once the app starts generating output."}</span>
            ) : (
              <pre className="whitespace-pre-wrap">{lines.join("\n")}</pre>
            )
          )}
        </Terminal>
      </div>
    </div>
  )
}
