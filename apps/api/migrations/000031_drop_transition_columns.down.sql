ALTER TABLE apps ADD COLUMN live_url TEXT;

UPDATE apps SET live_url = (SELECT r.live_url FROM app_runtime r WHERE r.app_id = apps.id);

ALTER TABLE deployments ADD COLUMN teardown_requested_at TIMESTAMPTZ;
