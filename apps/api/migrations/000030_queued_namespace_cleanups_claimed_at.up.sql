-- The controller claims a queued namespace cleanup before it deletes the
-- namespace, like the other queues (#354). Renaming a project back to the
-- slug of a queued namespace makes that namespace the live one again, so the
-- API deletes the row then, but only while it is unclaimed: once the
-- controller has claimed it, the namespace may already be going, and the
-- rename-back is refused until the controller is done. claim_token names the
-- claim, so a worker whose claim expired can't release, block or finish the
-- claim of the worker that took the row over.
ALTER TABLE queued_namespace_cleanups
  ADD COLUMN claimed_at TIMESTAMPTZ;

ALTER TABLE queued_namespace_cleanups
  ADD COLUMN claim_token TEXT;
