-- Object identity for the cleanup queues (#333).
--
-- An app cleanup removes only the objects labelled with the deleted app's id
-- (canette.dev/app-id), so a cleanup retried after the slug was reused leaves
-- the new app alone. Rows queued before this migration have no app_id, and
-- the controller matches their objects by the app slug label, as before.
--
-- Each queue row now stays until the objects are gone, not only until
-- Kubernetes accepted the delete. A PVC or a pod still terminating keeps the
-- row. Then the controller releases the claim, pushes next_attempt_at out,
-- and records on a cleanup what it is waiting for in pending_reason, for the
-- message createApp gives while the slug is still reserved. claim_token
-- names a claim, so a worker whose claim expired can't finish the claim of
-- the worker that took the row over (see 000030).
--
-- A volume deletion records the deleted volume's id, and the controller never
-- deletes an object labelled with another volume's id (canette.dev/volume-id).
-- A volume added while an earlier one with the same name is still being
-- deleted gets a suffixed name from createVolume, so its objects are new.
--
-- delete_requested_at marks a namespace cleanup whose delete was sent, while
-- the namespace terminates. A project rename back to that slug is refused
-- until the row is gone, like while it is claimed.
ALTER TABLE queued_app_cleanups ADD COLUMN app_id TEXT;

ALTER TABLE queued_app_cleanups ADD COLUMN claim_token TEXT;

ALTER TABLE queued_app_cleanups ADD COLUMN next_attempt_at TIMESTAMPTZ;

ALTER TABLE queued_app_cleanups ADD COLUMN pending_reason TEXT;

ALTER TABLE pending_volume_deletions ADD COLUMN volume_id TEXT;

ALTER TABLE pending_volume_deletions ADD COLUMN claim_token TEXT;

ALTER TABLE pending_volume_deletions ADD COLUMN next_attempt_at TIMESTAMPTZ;

ALTER TABLE queued_namespace_cleanups ADD COLUMN delete_requested_at TIMESTAMPTZ;
