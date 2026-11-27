-- The identity of the workload the controller applied for a deployment
-- (#332): the Deployment's or CronJob's UID, which changes when the object is
-- deleted and created again under the same name, the metadata.generation the
-- apply wrote, and for a Deployment the deployment.kubernetes.io/revision its
-- rollout reached. The controller checks a rollout against them, and is
-- their only writer.
--
-- On app_runtime they describe what is applied now, next to
-- applied_deployment_id, and are cleared with it. On deployments they are the
-- record of what each attempt applied. Both are only added, so the previous
-- release keeps working while the upgrade rolls out.
ALTER TABLE app_runtime ADD COLUMN applied_workload_uid TEXT;

ALTER TABLE app_runtime ADD COLUMN applied_workload_generation BIGINT;

ALTER TABLE app_runtime ADD COLUMN applied_workload_revision TEXT;

ALTER TABLE deployments ADD COLUMN workload_uid TEXT;

ALTER TABLE deployments ADD COLUMN workload_generation BIGINT;

ALTER TABLE deployments ADD COLUMN workload_revision TEXT;
