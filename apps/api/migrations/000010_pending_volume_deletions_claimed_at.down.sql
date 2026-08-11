DROP INDEX IF EXISTS idx_pending_volume_deletions_claim;
ALTER TABLE pending_volume_deletions DROP COLUMN IF EXISTS claimed_at;
