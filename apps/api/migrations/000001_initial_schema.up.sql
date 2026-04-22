-- canette initial schema

-- ── better-auth tables ────────────────────────────────────────────────────────
-- Timestamps kept as TEXT — better-auth owns these columns and writes string values.

CREATE TABLE "user" (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  "emailVerified"  BOOLEAN NOT NULL DEFAULT FALSE,
  image            TEXT,
  role             TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('admin', 'developer')),
  "createdAt"      TEXT NOT NULL,
  "updatedAt"      TEXT NOT NULL
);

CREATE TABLE "session" (
  id           TEXT PRIMARY KEY,
  "expiresAt"  TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  "createdAt"  TEXT NOT NULL,
  "updatedAt"  TEXT NOT NULL,
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "userId"     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE "account" (
  id                       TEXT PRIMARY KEY,
  "accountId"              TEXT NOT NULL,
  "providerId"             TEXT NOT NULL,
  "userId"                 TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken"            TEXT,
  "refreshToken"           TEXT,
  "idToken"                TEXT,
  "accessTokenExpiresAt"   TEXT,
  "refreshTokenExpiresAt"  TEXT,
  scope                    TEXT,
  password                 TEXT,
  "createdAt"              TEXT NOT NULL,
  "updatedAt"              TEXT NOT NULL
);

CREATE TABLE "verification" (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  value        TEXT NOT NULL,
  "expiresAt"  TEXT NOT NULL,
  "createdAt"  TEXT,
  "updatedAt"  TEXT
);

-- ── Application tables ────────────────────────────────────────────────────────

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT NOT NULL REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE memberships (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('admin', 'developer')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id, project_id)
);

CREATE TABLE git_credentials (
  id               TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES "user"(id) ON DELETE CASCADE, -- nullable for system credentials
  name             TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea', 'generic')),
  type             TEXT NOT NULL CHECK (type IN ('pat', 'ssh_key', 'github_app')),
  encrypted_value  TEXT NOT NULL, -- AES-256-GCM encrypted PAT token, SSH private key, or GitHub App private key
  ssh_known_hosts  TEXT,          -- plain text, not secret
  created_at       TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE apps (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'git' CHECK (source_type IN ('git', 'image')),
  git_url           TEXT NOT NULL DEFAULT '',
  git_branch        TEXT NOT NULL DEFAULT 'main',
  git_credential_id TEXT REFERENCES git_credentials(id) ON DELETE SET NULL,
  app_path          TEXT NOT NULL DEFAULT '',
  image_url         TEXT NOT NULL DEFAULT '',
  image_tag         TEXT NOT NULL DEFAULT '',
  port              INTEGER NOT NULL DEFAULT 3000,
  live_url          TEXT,
  canette_config    TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  UNIQUE(project_id, name),
  UNIQUE(project_id, slug)
);

CREATE TABLE deployments (
  id                  TEXT PRIMARY KEY,
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending_build'
                        CHECK (status IN ('pending_build','building','scanning','pending_deployment','deploying','live','failed','stopped')),
  commit_sha          TEXT NOT NULL,
  commit_message      TEXT,
  image_digest        TEXT,
  triggered_by        TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  error_message       TEXT,
  build_job_name      TEXT,
  applied_manifest    TEXT,
  scan_status         TEXT CHECK (scan_status IN ('pass', 'fail', 'error', 'skipped')),
  scan_summary        TEXT,
  canette_config      TEXT,
  deployment_snapshot TEXT,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE build_logs (
  id            TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  line          TEXT NOT NULL,
  stream        TEXT NOT NULL DEFAULT 'stdout' CHECK (stream IN ('stdout', 'stderr', 'controller')),
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE secrets (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  encrypted_value TEXT NOT NULL, -- AES-256-GCM; empty string stored encrypted, never null
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE(app_id, key)
);

CREATE TABLE env_vars (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(app_id, key)
);

CREATE TABLE webhook_secrets (
  id               TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
  secret           TEXT NOT NULL,
  watch_path       TEXT NOT NULL DEFAULT '',
  provider_hook_id TEXT,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE pending_namespace_deletions (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE admin_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE scan_sboms (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  format        TEXT NOT NULL DEFAULT 'cyclonedx',
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_session_token              ON "session"(token);
CREATE INDEX idx_account_user              ON "account"("userId");
CREATE INDEX idx_memberships_user_id       ON memberships(user_id);
CREATE INDEX idx_memberships_project_id    ON memberships(project_id);
CREATE UNIQUE INDEX idx_projects_slug      ON projects(slug);
CREATE INDEX idx_apps_project_id           ON apps(project_id);
CREATE UNIQUE INDEX idx_apps_project_slug  ON apps(project_id, slug);
CREATE INDEX idx_git_credentials_user_id   ON git_credentials(user_id);
CREATE INDEX idx_deployments_app_id        ON deployments(app_id);
CREATE INDEX idx_deployments_status        ON deployments(status);
CREATE INDEX idx_deployments_app_created   ON deployments(app_id, created_at DESC);
CREATE INDEX idx_build_logs_deployment     ON build_logs(deployment_id);
CREATE INDEX idx_secrets_app_id            ON secrets(app_id);
CREATE INDEX idx_env_vars_app_id           ON env_vars(app_id);
CREATE INDEX idx_webhook_secrets_app_id    ON webhook_secrets(app_id);

-- ── Seed data ─────────────────────────────────────────────────────────────────

INSERT INTO admin_settings (key, value, updated_at) VALUES
  ('security.scan_enabled',            'false',    NOW()),
  ('security.scan_mandatory',          'false',    NOW()),
  ('security.fail_severity',           'CRITICAL', NOW()),
  ('resources.default_cpu_request',    '100m',     NOW()),
  ('resources.default_memory_request', '128Mi',    NOW()),
  ('resources.default_cpu_limit',      '500m',     NOW()),
  ('resources.default_memory_limit',   '512Mi',    NOW());
