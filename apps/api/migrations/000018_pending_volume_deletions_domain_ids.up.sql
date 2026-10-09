-- pending_volume_deletions used to store a fully resolved K8s namespace and
-- resource name computed by the API. K8s naming belongs to the Go side
-- (packages/golib/k8s), so new rows store domain identifiers instead and the
-- controller resolves them. The legacy columns stay (nullable) so rows queued
-- before this migration are still drained. Drop them in a later release.
--
-- Rebuilt rather than ALTERed because SQLite (used in tests) can't drop a
-- NOT NULL constraint.
CREATE TABLE pending_volume_deletions_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  project_slug  TEXT,
  app_slug      TEXT,
  volume_name   TEXT,
  volume_type   TEXT CHECK (volume_type IN ('pvc', 'configmap')),
  namespace     TEXT,
  resource_type TEXT CHECK (resource_type IN ('PersistentVolumeClaim', 'ConfigMap')),
  resource_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at    TIMESTAMPTZ,
  CHECK (
    (project_id IS NOT NULL AND project_slug IS NOT NULL AND app_slug IS NOT NULL
      AND volume_name IS NOT NULL AND volume_type IS NOT NULL)
    OR (namespace IS NOT NULL AND resource_type IS NOT NULL AND resource_name IS NOT NULL)
  )
);

INSERT INTO pending_volume_deletions_new (id, namespace, resource_type, resource_name, created_at, claimed_at)
  SELECT id, namespace, resource_type, resource_name, created_at, claimed_at
  FROM pending_volume_deletions;

DROP TABLE pending_volume_deletions;

ALTER TABLE pending_volume_deletions_new RENAME TO pending_volume_deletions;

CREATE INDEX idx_pending_volume_deletions_claim
  ON pending_volume_deletions (claimed_at, created_at);
