// Shared API response types — used by both apps/api and apps/ui.
// These mirror the database schema. Never include encrypted fields here.

export type UserRole = "admin" | "developer"

export interface User {
  id: string
  name: string
  email: string
  image?: string
  role: UserRole
  createdAt: string
  hasPassword?: boolean
}

export interface Team {
  id: string
  name: string
  isPersonal: boolean
  ownerId: string
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface TeamMember {
  userId: string
  name: string
  email: string
  image?: string
  joinedAt: string
}

export interface Project {
  id: string
  teamId: string
  name: string
  slug: string
  description?: string
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export type GitProvider = "github" | "gitlab" | "gitea" | "generic"
export type GitCredentialType = "pat" | "ssh_key" | "github_app"

export interface GitCredential {
  id: string
  teamId: string | null  // null for system credentials (e.g. cluster GitHub App)
  name: string
  provider: GitProvider
  type: GitCredentialType
  installationId?: string    // only present for github_app type (per-team installations)
  connectedByUserId?: string // only present for github_app type (per-team installations)
  createdAt: string
  // encrypted_value is never returned by the API
}

export type AppSourceType = "git" | "image"

export interface App {
  id: string
  projectId: string
  name: string
  slug: string
  sourceType: AppSourceType
  // Git source (empty string when sourceType === 'image')
  gitUrl: string
  gitBranch: string
  gitCredentialId?: string
  appPath: string
  // Image source (empty string when sourceType === 'git')
  imageUrl: string
  imageTag: string
  port: number
  liveUrl?: string
  latestDeploymentStatus?: DeploymentStatus
  canetteConfig?: string
  createdAt: string
  updatedAt: string
}

export interface EnvVar {
  id: string
  appId: string
  key: string
  value: string
  createdAt: string
  updatedAt: string
}

export interface AppSecret {
  id: string
  appId: string
  key: string
  // encrypted_value is intentionally absent — write-only after storage
  createdAt: string
  updatedAt: string
}

export type DeploymentStatus =
  | "pending_build"
  | "building"
  | "scanning"
  | "pending_deployment"
  | "deploying"
  | "live"
  | "failed"
  | "stopped"

export type ScanStatus = "pass" | "fail" | "error" | "skipped"

export interface ScanSummary {
  critical: number
  high: number
  medium: number
  low: number
  unknown: number
}

export interface Deployment {
  id: string
  appId: string
  status: DeploymentStatus
  commitSha: string
  commitMessage?: string
  imageDigest?: string
  triggeredBy?: string
  errorMessage?: string
  scanStatus?: ScanStatus
  scanSummary?: ScanSummary
  createdAt: string
  updatedAt: string
}

export interface ScanPolicy {
  enabled: boolean
  mandatory: boolean
  failSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
}

export interface BuildLog {
  id: string
  deploymentId: string
  createdAt: string
  line: string
}

export interface WebhookConfig {
  appId: string
  provider: string
  watchPath: string
  autoRegistered: boolean
  verifiedAt?: string
  createdAt: string
  webhookUrl: string
}

export interface WebhookSettings {
  baseUrl: string  // empty = use default (UI_URL)
}

// Admin types

export interface AdminAppSummary {
  id: string
  name: string
  slug: string
  sourceType: AppSourceType
  liveUrl?: string
  latestDeploymentStatus?: DeploymentStatus
  latestDeploymentAt?: string
}

export interface AdminProjectOverview {
  id: string
  name: string
  slug: string
  teamName: string
  createdAt: string
  apps: AdminAppSummary[]
}

export interface AdminTeamOverview {
  id: string
  name: string
  isPersonal: boolean
  memberCount: number
  projectCount: number
  createdAt: string
}

export interface ResourceDefaults {
  cpuRequest: string
  memoryRequest: string
  cpuLimit: string
  memoryLimit: string
}

export interface SyncResult {
  synced: number
  message: string
}

// API envelope types

export interface ApiError {
  error: string
  code: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
