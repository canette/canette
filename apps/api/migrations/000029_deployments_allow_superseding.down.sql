-- As in 000024: of an app's in-progress deployments, all but the newest are
-- failed before the index can be created again.
UPDATE deployments
SET status = 'failed',
    error_message = 'Superseded by a newer deployment that was in progress at the same time',
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying')
  AND EXISTS (
    SELECT 1 FROM deployments newer
    WHERE newer.app_id = deployments.app_id
      AND newer.status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying')
      AND (newer.created_at > deployments.created_at
           OR (newer.created_at = deployments.created_at AND newer.id > deployments.id))
  );

CREATE UNIQUE INDEX idx_deployments_one_active_per_app
  ON deployments (app_id)
  WHERE status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying');
