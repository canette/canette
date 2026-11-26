-- What the user wants each app to run, kept apart from the deployment history
-- (#354). Only the API writes this table. Every lifecycle action (deploy,
-- redeploy, stop, admin repair) locks the app's row first, bumps generation
-- and records the desired state and the deployment it targets, in the same
-- transaction as its other writes. Config edits do not bump generation: they
-- take effect on the next deployment, as before.
--
-- target_deployment_id is the attempt that should run while desired_state is
-- running. Stop keeps it, so it still names the attempt to bring back.
CREATE TABLE app_intents (
  app_id               TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  generation           BIGINT NOT NULL DEFAULT 0,
  desired_state        TEXT NOT NULL DEFAULT 'stopped'
                         CHECK (desired_state IN ('running', 'stopped')),
  target_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

-- An app is running unless its latest deployment is stopped or it has none,
-- the same rule the API uses for an app's status today. Its target is its
-- latest deployment. Apps with history start at generation 1.
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

-- superseded: an attempt that a newer deploy or a Stop replaced before it
-- went live, or an older live attempt once a newer one is live. Nothing
-- writes it yet. SQLite can't alter a CHECK, so it has its own version of
-- this migration (000027_app_intents.up.sqlite.sql).
ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;

ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('pending_build', 'building', 'scanning', 'pending_deployment',
                    'deploying', 'live', 'failed', 'stopped', 'superseded'));
