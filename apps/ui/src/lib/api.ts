// Typed API client — thin wrapper around fetch.
// All requests go through Next.js rewrites → API server.
// Never call the API directly from the browser with a hardcoded URL.

import type { AdminProjectOverview, AdminTeamOverview, App, AppSecret, BuildLog, Deployment, EnvVar, GitCredential, GitCredentialType, GitProvider, PaginatedResponse, Project, ResourceDefaults, ScanPolicy, SyncResult, Team, TeamMember, User, UserRole, WebhookConfig, WebhookSettings } from "@canette/types"

const base = "/api/v1"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
  })
  if (!res.ok) {
    if (res.status === 401) {
      // Session has expired or is invalid. Force a full navigation to /login
      // so the middleware clears the stale cookie and the user can re-auth.
      // We still throw so callers get a clean rejection rather than a hung promise.
      if (typeof window !== "undefined") {
        window.location.replace("/login")
      }
      throw new Error("Session expired")
    }
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// Teams
export const teams = {
  list: () => request<Team[]>("/teams"),
  get: (id: string) => request<Team & { members: TeamMember[] }>(`/teams/${id}`),
  create: (body: { name: string }) =>
    request<Team>("/teams", { method: "POST", body: JSON.stringify(body) }),
  rename: (id: string, name: string) =>
    request<Team>(`/teams/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  delete: (id: string) => request<void>(`/teams/${id}`, { method: "DELETE" }),
  addMember: (teamId: string, body: { userId?: string; email?: string }) =>
    request<void>(`/teams/${teamId}/members`, { method: "POST", body: JSON.stringify(body) }),
  removeMember: (teamId: string, userId: string) =>
    request<void>(`/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
  listCredentials: (teamId: string) =>
    request<GitCredential[]>(`/teams/${teamId}/credentials`),
  createCredential: (teamId: string, body: { name: string; provider: GitProvider; type: GitCredentialType; value?: string; sshKnownHosts?: string }) =>
    request<GitCredential>(`/teams/${teamId}/credentials`, { method: "POST", body: JSON.stringify(body) }),
  updateCredential: (teamId: string, id: string, value: string) =>
    request<GitCredential>(`/teams/${teamId}/credentials/${id}`, { method: "PATCH", body: JSON.stringify({ value }) }),
  deleteCredential: (teamId: string, id: string) =>
    request<void>(`/teams/${teamId}/credentials/${id}`, { method: "DELETE" }),
}

// GitHub App
export const githubApp = {
  getInstallUrl: (teamId: string) =>
    request<{ available: boolean; url?: string }>(`/github-app/install-url?teamId=${teamId}`),
}

// Projects
export const projects = {
  list: () => request<PaginatedResponse<Project>>("/projects"),
  get: (idOrSlug: string) => request<Project>(`/projects/${idOrSlug}`),
  create: (body: { teamId: string; name: string; slug: string; description?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: { name?: string; description?: string; slug?: string }) =>
    request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),
  listCredentials: (idOrSlug: string) => request<GitCredential[]>(`/projects/${idOrSlug}/credentials`),
}

// Apps
export const apps = {
  list: (projectId: string) => request<PaginatedResponse<App>>(`/projects/${projectId}/apps`),
  get: (id: string) => request<App>(`/apps/${id}`),
  getBySlug: (projectSlug: string, appSlug: string) =>
    request<App>(`/projects/${projectSlug}/apps/${appSlug}`),
  create: (
    projectId: string,
    body: {
      name: string
      slug: string
      sourceType?: "git" | "image"
      gitUrl?: string
      gitBranch?: string
      appPath?: string
      imageUrl?: string
      imageTag?: string
      port?: number
    }
  ) => request<App>(`/projects/${projectId}/apps`, { method: "POST", body: JSON.stringify(body) }),
  update: (
    id: string,
    body: {
      name?: string
      sourceType?: "git" | "image"
      gitUrl?: string
      gitBranch?: string
      appPath?: string
      imageUrl?: string
      imageTag?: string
      port?: number
      gitCredentialId?: string | null
      canetteConfig?: string | null
    }
  ) => request<App>(`/apps/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  stop: (id: string) => request<{ ok: boolean }>(`/apps/${id}/stop`, { method: "POST" }),
  delete: (id: string) => request<void>(`/apps/${id}`, { method: "DELETE" }),
}

// Deployments
export const deployments = {
  list: (appId: string) => request<PaginatedResponse<Deployment>>(`/apps/${appId}/deployments`),
  trigger: (appId: string) =>
    request<Deployment>(`/apps/${appId}/deployments`, { method: "POST" }),
  logs: (deploymentId: string) => request<{ items: BuildLog[] }>(`/deployments/${deploymentId}/logs`),
  manifest: (deploymentId: string) => request<{ manifest: string }>(`/deployments/${deploymentId}/manifest`),
  sbom: (deploymentId: string) => request<{ sbom: string }>(`/deployments/${deploymentId}/sbom`),
  redeploy: (deploymentId: string) => request<Deployment>(`/deployments/${deploymentId}/redeploy`, { method: "POST" }),
}

// Webhooks
export const webhooks = {
  get: (appId: string) => request<WebhookConfig>(`/apps/${appId}/webhook`),
  create: (appId: string, watchPath: string) =>
    request<{
      config: WebhookConfig
      webhookUrl: string
      webhookSecret: string
      autoRegistered: boolean
      setupInstructions?: string
    }>(`/apps/${appId}/webhook`, { method: "POST", body: JSON.stringify({ watchPath }) }),
  delete: (appId: string) => request<void>(`/apps/${appId}/webhook`, { method: "DELETE" }),
}

// App runtime logs
export const appLogs = {
  stream: (appId: string) =>
    new EventSource(`${base}/apps/${appId}/logs/stream`, { withCredentials: true }),
}

// Current user
export const users = {
  me: () => request<User>("/users/me"),
  updateMe: (body: { name: string }) =>
    request<User>("/users/me", { method: "PATCH", body: JSON.stringify(body) }),
}

// Admin
export const admin = {
  listUsers: () => request<User[]>("/admin/users"),
  updateUserRole: (id: string, role: UserRole) =>
    request<User>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  deleteUser: (id: string) => request<void>(`/admin/users/${id}`, { method: "DELETE" }),
  getOverview: () => request<AdminProjectOverview[]>("/admin/overview"),
  getTeams: () => request<AdminTeamOverview[]>("/admin/teams"),
  sync: () => request<SyncResult>("/admin/sync", { method: "POST" }),
  resetStuck: () => request<SyncResult>("/admin/reset-stuck", { method: "POST" }),
  getScanPolicy: () => request<ScanPolicy>("/admin/settings/security"),
  updateScanPolicy: (patch: Partial<ScanPolicy>) =>
    request<ScanPolicy>("/admin/settings/security", { method: "PATCH", body: JSON.stringify(patch) }),
  getWebhookSettings: () => request<WebhookSettings>("/admin/settings/webhooks"),
  getResourceDefaults: () => request<ResourceDefaults>("/admin/settings/resources"),
  resetUserPassword: (id: string) =>
    request<{ password: string }>(`/admin/users/${id}/reset-password`, { method: "POST" }),
}

// Environment variables and secrets
export const env = {
  list: (appId: string) =>
    request<{ envVars: EnvVar[]; secrets: AppSecret[] }>(`/apps/${appId}/env`),
  putVar: (appId: string, key: string, value: string) =>
    request<EnvVar>(`/apps/${appId}/env/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteVar: (appId: string, key: string) =>
    request<void>(`/apps/${appId}/env/${encodeURIComponent(key)}`, { method: "DELETE" }),
  putSecret: (appId: string, key: string, value: string) =>
    request<AppSecret>(`/apps/${appId}/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteSecret: (appId: string, key: string) =>
    request<void>(`/apps/${appId}/secrets/${encodeURIComponent(key)}`, { method: "DELETE" }),
}
