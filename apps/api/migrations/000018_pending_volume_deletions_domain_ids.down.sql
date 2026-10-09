-- Rows queued in the domain-identifier shape can't be expressed in the old
-- schema without re-implementing K8s naming in SQL, so they are dropped here.
-- Their PVCs/ConfigMaps must be removed by hand after a rollback.
CREATE TABLE pending_volume_deletions_old (
  id            TEXT PRIMARY KEY,
  namespace     TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('PersistentVolumeClaim', 'ConfigMap')),
  resource_name TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at    TIMESTAMPTZ
);

INSERT INTO pending_volume_deletions_old (id, namespace, resource_type, resource_name, created_at, claimed_at)
  SELECT id, namespace, resource_type, resource_name, created_at, claimed_at
  FROM pending_volume_deletions
  WHERE namespace IS NOT NULL;

DROP TABLE pending_volume_deletions;

ALTER TABLE pending_volume_deletions_old RENAME TO pending_volume_deletions;

CREATE INDEX idx_pending_volume_deletions_claim
  ON pending_volume_deletions (claimed_at, created_at);
