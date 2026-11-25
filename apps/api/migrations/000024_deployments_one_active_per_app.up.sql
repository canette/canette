-- At most one deployment per app may be in progress. createDeployment and
-- redeployDeployment check for one before inserting, but two requests at the
-- same moment could both pass that check. The index makes the database reject
-- the second insert, and the API turns that into DEPLOYMENT_IN_PROGRESS (409).
--
-- Rows that already break the rule are fixed first, or the index can't be
-- created: of an app's in-progress deployments, all but the newest are failed.
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
