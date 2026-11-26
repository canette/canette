-- Moves the health watcher's runtime health verdict (added to apps by
-- 000016) to app_observed_status, so the controller no longer writes the
-- apps row the API edits. A missing row, or a row the status reader created
-- before any verdict, reads as 'unknown', the same as the old apps default.
ALTER TABLE app_observed_status ADD COLUMN runtime_health TEXT NOT NULL DEFAULT 'unknown'
  CHECK (runtime_health IN ('healthy', 'unhealthy', 'unknown'));
ALTER TABLE app_observed_status ADD COLUMN runtime_health_reason TEXT;
ALTER TABLE app_observed_status ADD COLUMN runtime_health_updated_at TIMESTAMPTZ;

-- Copy the verdict of every app the watcher has observed. Apps never
-- observed keep no row, which already means 'unknown'.
INSERT INTO app_observed_status (app_id, runtime_health, runtime_health_reason, runtime_health_updated_at)
SELECT id, runtime_health, runtime_health_reason, runtime_health_updated_at
FROM apps
WHERE runtime_health_updated_at IS NOT NULL OR runtime_health <> 'unknown'
ON CONFLICT (app_id) DO UPDATE
SET runtime_health = excluded.runtime_health,
    runtime_health_reason = excluded.runtime_health_reason,
    runtime_health_updated_at = excluded.runtime_health_updated_at;

ALTER TABLE apps DROP COLUMN runtime_health_updated_at;
ALTER TABLE apps DROP COLUMN runtime_health_reason;
ALTER TABLE apps DROP COLUMN runtime_health;
