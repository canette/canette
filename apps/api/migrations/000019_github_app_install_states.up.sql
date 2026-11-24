-- Single-use state for the GitHub App installation flow. One row per step:
-- the install step (installation_id NULL) and the user-authorization step
-- that proves the user can access the installation (installation_id and the
-- PKCE code_verifier set). Each row is deleted when its callback consumes it.
CREATE TABLE github_app_install_states (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  installation_id TEXT,
  code_verifier  TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
