ALTER TABLE deployments DROP COLUMN workload_revision;

ALTER TABLE deployments DROP COLUMN workload_generation;

ALTER TABLE deployments DROP COLUMN workload_uid;

ALTER TABLE app_runtime DROP COLUMN applied_workload_revision;

ALTER TABLE app_runtime DROP COLUMN applied_workload_generation;

ALTER TABLE app_runtime DROP COLUMN applied_workload_uid;
