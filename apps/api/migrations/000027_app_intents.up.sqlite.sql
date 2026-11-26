-- SQLite version of 000027_app_intents.up.sql, used only by tests and e2e
-- (see runMigrations). SQLite can't alter a CHECK constraint, so deployments
-- is rebuilt with superseded added. Keep the columns and indexes in step with
-- the Postgres schema.
CREATE TABLE deployments_new (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending_build'
                          CHECK (status IN ('pending_build','building','scanning','pending_deployment','deploying','live','failed','stopped','superseded')),
  commit_sha            TEXT NOT NULL,
  commit_message        TEXT,
  image_digest          TEXT,
  triggered_by          TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  error_message         TEXT,
  build_job_name        TEXT,
  applied_manifest      TEXT,
  scan_status           TEXT CHECK (scan_status IN ('pass', 'fail', 'error', 'skipped')),
  scan_summary          TEXT,
  canette_config        TEXT,
  deployment_snapshot   TEXT,
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL,
  claimed_at            TIMESTAMPTZ,
  teardown_requested_at TIMESTAMPTZ
);

INSERT INTO deployments_new (id, app_id, status, commit_sha, commit_message, image_digest,
  triggered_by, error_message, build_job_name, applied_manifest, scan_status, scan_summary,
  canette_config, deployment_snapshot, created_at, updated_at, claimed_at, teardown_requested_at)
SELECT id, app_id, status, commit_sha, commit_message, image_digest,
  triggered_by, error_message, build_job_name, applied_manifest, scan_status, scan_summary,
  canette_config, deployment_snapshot, created_at, updated_at, claimed_at, teardown_requested_at
FROM deployments;

DROP TABLE deployments;

ALTER TABLE deployments_new RENAME TO deployments;

CREATE INDEX idx_deployments_app_id ON deployments(app_id);

CREATE INDEX idx_deployments_status ON deployments(status);

CREATE INDEX idx_deployments_app_created ON deployments(app_id, created_at DESC);

CREATE INDEX idx_deployments_deploying_claimed_at
  ON deployments (claimed_at) WHERE status = 'deploying';

CREATE UNIQUE INDEX idx_deployments_one_active_per_app
  ON deployments (app_id)
  WHERE status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying');

CREATE TABLE app_intents (
  app_id               TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  generation           BIGINT NOT NULL DEFAULT 0,
  desired_state        TEXT NOT NULL DEFAULT 'stopped'
                         CHECK (desired_state IN ('running', 'stopped')),
  target_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

INSERT INTO app_intents (app_id, generation, desired_state, target_deployment_id, updated_at)
SELECT a.id,
       CASE WHEN latest.id IS NULL THEN 0 ELSE 1 END,
       CASE WHEN latest.id IS NULL OR latest.status = 'stopped' THEN 'stopped' ELSE 'running' END,
       latest.id,
       CURRENT_TIMESTAMP
FROM apps a
LEFT JOIN deployments latest ON latest.id = (
  SELECT d.id FROM deployments d
  WHERE d.app_id = a.id
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT 1
);
