-- The end of the move to versioned app intent (#354). Stop now only records
-- the app's intent, the controller tears the app down from it and records
-- the attempts it stopped, and app_runtime holds the live URL. The old
-- markers are no longer written or read: teardown_requested_at (a failed
-- attempt Stop marked for teardown) and apps.live_url (now
-- app_runtime.live_url).
ALTER TABLE deployments DROP COLUMN teardown_requested_at;

ALTER TABLE apps DROP COLUMN live_url;
