-- Tombstones for deleted apps. Deleting an app cascades its deployments, so
-- the controller can no longer find the app's K8s resources through them.
-- The API writes one row per deleted app in the same transaction as the
-- delete. The controller resolves the domain identifiers to the namespace
-- and resource names, removes everything the app owned (workload, routes,
-- Secrets, PVCs, ConfigMaps) and deletes the row. createApp refuses a slug
-- that still has a row here, so cleanup can never hit a new app's resources.
CREATE TABLE queued_app_cleanups (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  app_slug     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at   TIMESTAMPTZ,
  UNIQUE (project_id, app_slug)
);

CREATE INDEX idx_queued_app_cleanups_claim
  ON queued_app_cleanups (claimed_at, created_at);
