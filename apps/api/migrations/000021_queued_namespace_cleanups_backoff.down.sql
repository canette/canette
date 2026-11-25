DROP INDEX IF EXISTS idx_queued_namespace_cleanups_next_attempt;
ALTER TABLE queued_namespace_cleanups DROP COLUMN IF EXISTS blocked_reason;
ALTER TABLE queued_namespace_cleanups DROP COLUMN IF EXISTS next_attempt_at;
