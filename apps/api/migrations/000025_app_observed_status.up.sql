-- What the controller has observed in Kubernetes for an app, kept apart from
-- apps (the user's intent, written by the API). Only the controller writes
-- this table: it creates the row on its first observation with an upsert, so
-- an app has no row until then. Readers LEFT JOIN it on app_id.
--
-- kubernetes_status is what Kubernetes reports for the app's workload object,
-- written as JSON by the controller's status reader
-- (apps/controller/internal/health/kubestatus.go): Deployment capacity for
-- web/private apps, CronJob state and latest Job outcome for cronjobs.
-- kubernetes_status_observed_at is when it was last read. The API treats an
-- old reading as unknown, the same rule as apps.runtime_health_updated_at.
CREATE TABLE app_observed_status (
  app_id                        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  kubernetes_status             TEXT,
  kubernetes_status_observed_at TIMESTAMPTZ
);
