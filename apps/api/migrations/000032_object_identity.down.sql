ALTER TABLE queued_namespace_cleanups DROP COLUMN delete_requested_at;

ALTER TABLE pending_volume_deletions DROP COLUMN next_attempt_at;

ALTER TABLE pending_volume_deletions DROP COLUMN claim_token;

ALTER TABLE pending_volume_deletions DROP COLUMN volume_id;

ALTER TABLE queued_app_cleanups DROP COLUMN pending_reason;

ALTER TABLE queued_app_cleanups DROP COLUMN next_attempt_at;

ALTER TABLE queued_app_cleanups DROP COLUMN claim_token;

ALTER TABLE queued_app_cleanups DROP COLUMN app_id;
