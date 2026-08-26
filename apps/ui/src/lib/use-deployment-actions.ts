"use client"

import { useCallback, useEffect, useState } from "react"
import * as api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type { Deployment } from "@canette/types"

const ACTIVE_STATUSES = ["pending_build", "building", "scanning", "pending_deployment", "deploying"]
const REDEPLOYABLE_STATUSES = ["live", "failed", "stopped"]

/**
 * Shared deployment list + Deploy/Redeploy/Stop action state, used by both the
 * Overview and Deployments tabs so they stay in sync instead of each keeping
 * an independent copy of the same fetch/action logic.
 */
export function useDeploymentActions(appId: string, opts?: { limit?: number; onSettled?: () => void }) {
  const { limit = 5, onSettled } = opts ?? {}

  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")

  const [deploying, setDeploying] = useState(false)
  const [redeployingId, setRedeployingId] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")

  const load = useCallback(async () => {
    try {
      const data = await api.deployments.list(appId, limit)
      setDeploymentList(data.items)
      setLoadError("")
    } catch (e: unknown) {
      const status = e instanceof ApiError ? ` (HTTP ${e.status})` : ""
      setLoadError(`Failed to load deployments${status}: ${e instanceof Error ? e.message : "unknown error"}`)
    } finally {
      setLoading(false)
    }
    // Notify the parent (e.g. the app header's status/link) on every list refresh —
    // not just after actions — so it stays in sync even when this hook remounts
    // (switching tabs mid-deploy and back) rather than only via the action call sites.
    onSettled?.()
  }, [appId, limit, onSettled])

  useEffect(() => { load() }, [load])

  const hasActiveDeployment = deploymentList.some((d) => ACTIVE_STATUSES.includes(d.status))
  const liveDeployment = deploymentList.find((d) => d.status === "live")
  const latestDeployment = deploymentList[0]
  const currentDeployment = liveDeployment ?? latestDeployment

  const canRedeployDeployment = useCallback(
    (d?: Deployment) => !!(d?.imageDigest && !hasActiveDeployment && REDEPLOYABLE_STATUSES.includes(d.status)),
    [hasActiveDeployment],
  )
  const canRedeploy = canRedeployDeployment(currentDeployment)

  // Auto-refresh while active
  useEffect(() => {
    if (!hasActiveDeployment) return
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [hasActiveDeployment, load])

  async function deploy() {
    setActionError("")
    setDeploying(true)
    try {
      await api.deployments.trigger(appId)
      await load()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Deploy failed")
    } finally {
      setDeploying(false)
    }
  }

  async function redeploy(deploymentId: string) {
    setActionError("")
    setRedeployingId(deploymentId)
    try {
      await api.deployments.redeploy(deploymentId)
      await load()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Redeploy failed")
    } finally {
      setRedeployingId(null)
    }
  }

  async function stop() {
    setActionError("")
    setStopping(true)
    try {
      await api.apps.stop(appId)
      await load()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Stop failed")
    } finally {
      setStopping(false)
    }
  }

  return {
    deploymentList,
    loading,
    loadError,
    hasActiveDeployment,
    liveDeployment,
    latestDeployment,
    currentDeployment,
    canRedeploy,
    canRedeployDeployment,
    deploy,
    redeploy,
    stop,
    deploying,
    redeployingId,
    stopping,
    actionError,
    refresh: load,
  }
}
