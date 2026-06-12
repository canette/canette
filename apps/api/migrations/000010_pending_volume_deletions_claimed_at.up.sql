ALTER TABLE pending_volume_deletions
  ADD COLUMN claimed_at TIMESTAMPTZ;

CREATE INDEX idx_pending_volume_deletions_claim
  ON pending_volume_deletions (claimed_at, created_at);
