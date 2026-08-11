CREATE TABLE app_volumes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('pvc', 'emptyDir', 'configmap')),
  mount_path TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(app_id, name),
  UNIQUE(app_id, mount_path)
);

CREATE TABLE pending_volume_deletions (
  id            TEXT PRIMARY KEY,
  namespace     TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('PersistentVolumeClaim', 'ConfigMap')),
  resource_name TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
