-- A renamed project's old namespace is kept while it still holds PVCs. The
-- controller records why in blocked_reason and pushes next_attempt_at out, so
-- a blocked row is re-checked slowly, logged once, and never holds up the
-- rows queued behind it.
ALTER TABLE queued_namespace_cleanups
  ADD COLUMN next_attempt_at TIMESTAMPTZ;

ALTER TABLE queued_namespace_cleanups
  ADD COLUMN blocked_reason TEXT;

CREATE INDEX idx_queued_namespace_cleanups_next_attempt
  ON queued_namespace_cleanups (next_attempt_at, created_at);
