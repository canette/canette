DROP TABLE pending_namespace_deletions;
CREATE TABLE queued_namespace_cleanups (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, project_slug)
);
