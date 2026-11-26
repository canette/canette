-- What the controller has done about each app's intent (#354). Only the
-- controller writes this table. Its reconciler claims an app by setting
-- lease_token and claimed_at (the lease's heartbeat), checks the intent's
-- generation again under a lock on app_intents before every Kubernetes change,
-- and records the generation it finished in reconciled_generation. An app
-- needs work while app_intents.generation is ahead of it.
--
-- applied_deployment_id is the deployment whose resources the controller last
-- rolled out successfully, which is what serves traffic. live_url moves here
-- from apps, so the controller is its only writer.
CREATE TABLE app_runtime (
  app_id                TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  reconciled_generation BIGINT NOT NULL DEFAULT 0,
  applied_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  live_url              TEXT,
  lease_token           TEXT,
  claimed_at            TIMESTAMPTZ,
  last_error            TEXT
);

-- An app whose latest deployment is still being built or rolled out needs
-- work (reconciled 0). Every other app is reconciled up to its intent. Pending
-- teardowns from the old queue are found from their markers on deployments,
-- not from the generation.
INSERT INTO app_runtime (app_id, reconciled_generation, applied_deployment_id, live_url)
SELECT a.id,
       CASE WHEN latest.status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying')
            THEN 0 ELSE COALESCE(i.generation, 0) END,
       (SELECT d.id FROM deployments d
        WHERE d.app_id = a.id AND d.status = 'live'
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 1),
       a.live_url
FROM apps a
LEFT JOIN app_intents i ON i.app_id = a.id
LEFT JOIN deployments latest ON latest.id = (
  SELECT d.id FROM deployments d
  WHERE d.app_id = a.id
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT 1
);
