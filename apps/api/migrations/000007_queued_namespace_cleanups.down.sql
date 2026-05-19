DROP TABLE queued_namespace_cleanups;
CREATE TABLE pending_namespace_deletions (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);
