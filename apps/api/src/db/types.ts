// Database interface for Kysely — one interface per table, snake_case columns.
// The better-auth tables (user, session, account, verification) use camelCase
// column names because better-auth created them that way via quoted identifiers.

export interface Database {
  // ── better-auth tables (camelCase column names) ───────────────────────────

  user: {
    id: string
    name: string
    email: string
    emailVerified: boolean
    image: string | null
    role: string
    createdAt: string
    updatedAt: string
  }

  session: {
    id: string
    expiresAt: string
    token: string
    createdAt: string
    updatedAt: string
    ipAddress: string | null
    userAgent: string | null
    userId: string
  }

  account: {
    id: string
    accountId: string
    providerId: string
    userId: string
    accessToken: string | null
    refreshToken: string | null
    idToken: string | null
    accessTokenExpiresAt: string | null
    refreshTokenExpiresAt: string | null
    scope: string | null
    password: string | null
    createdAt: string
    updatedAt: string
  }

  verification: {
    id: string
    identifier: string
    value: string
    expiresAt: string
    createdAt: string | null
    updatedAt: string | null
  }

  // ── Application tables (snake_case column names) ──────────────────────────

  teams: {
    id: string
    name: string
    is_personal: boolean
    owner_id: string
    created_at: string
    updated_at: string
  }

  team_members: {
    id: string
    team_id: string
    user_id: string
    created_at: string
  }

  projects: {
    id: string
    team_id: string
    name: string
    slug: string
    description: string | null
    created_by: string | null
    created_at: string
    updated_at: string
  }

  git_credentials: {
    id: string
    team_id: string | null  // null for system credentials (e.g. cluster GitHub App)
    name: string
    provider: string
    type: string
    encrypted_value: string
    ssh_known_hosts: string | null
    installation_id: string | null  // only set for github_app type (per-team installations)
    connected_by_user_id: string | null  // user who connected this GitHub App installation
    created_at: string
  }

  apps: {
    id: string
    project_id: string
    name: string
    slug: string
    source_type: string
    git_url: string
    git_branch: string
    git_credential_id: string | null
    app_path: string
    image_url: string
    image_tag: string
    port: number
    deployment_type: string
    schedule: string | null
    live_url: string | null
    canette_config: string | null
    created_at: string
    updated_at: string
  }

  deployments: {
    id: string
    app_id: string
    status: string
    commit_sha: string
    commit_message: string | null
    image_digest: string | null
    triggered_by: string | null
    error_message: string | null
    scan_status: string | null
    scan_summary: string | null
    applied_manifest: string | null
    canette_config: string | null
    deployment_snapshot: string | null
    created_at: string
    updated_at: string
  }

  build_logs: {
    id: string
    deployment_id: string
    line: string
    stream: string
    created_at: string
  }

  env_vars: {
    id: string
    app_id: string
    key: string
    value: string
    created_at: string
    updated_at: string
  }

  secrets: {
    id: string
    app_id: string
    key: string
    encrypted_value: string
    created_at: string
    updated_at: string
  }

  webhook_secrets: {
    id: string
    app_id: string
    provider: string
    secret: string
    watch_path: string
    provider_hook_id: string | null
    verified_at: string | null
    created_at: string
  }

  admin_settings: {
    key: string
    value: string
    updated_at: string
  }

  scan_sboms: {
    deployment_id: string
    format: string
    content: string
    created_at: string
  }

  pending_namespace_deletions: {
    id: string
    namespace: string
    created_at: string
  }

  // ── DB Migration tracking ──────────────────────────

  schema_migrations: {
    version: string
    applied_at: string
  }

}