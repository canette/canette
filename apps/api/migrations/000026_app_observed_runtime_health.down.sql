ALTER TABLE apps ADD COLUMN runtime_health TEXT NOT NULL DEFAULT 'unknown'
  CHECK (runtime_health IN ('healthy', 'unhealthy', 'unknown'));
ALTER TABLE apps ADD COLUMN runtime_health_reason TEXT;
ALTER TABLE apps ADD COLUMN runtime_health_updated_at TIMESTAMPTZ;

UPDATE apps
SET runtime_health = COALESCE((SELECT o.runtime_health FROM app_observed_status o WHERE o.app_id = apps.id), 'unknown'),
    runtime_health_reason = (SELECT o.runtime_health_reason FROM app_observed_status o WHERE o.app_id = apps.id),
    runtime_health_updated_at = (SELECT o.runtime_health_updated_at FROM app_observed_status o WHERE o.app_id = apps.id);

ALTER TABLE app_observed_status DROP COLUMN runtime_health_updated_at;
ALTER TABLE app_observed_status DROP COLUMN runtime_health_reason;
ALTER TABLE app_observed_status DROP COLUMN runtime_health;
