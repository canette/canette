-- Of an app's in-progress deployments, all but one are failed before the
-- index can be created again. The one kept is the app's intent target when it
-- is in progress, otherwise the newest: the target is what the app should
-- run, and deploys can commit in another order than they were created.
UPDATE deployments
SET status = 'failed',
    error_message = 'Superseded by a newer deployment that was in progress at the same time',
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying')
  AND id <> (
    SELECT k.id FROM deployments k
    LEFT JOIN app_intents i ON i.app_id = k.app_id AND i.target_deployment_id = k.id
    WHERE k.app_id = deployments.app_id
      AND k.status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying')
    ORDER BY (i.app_id IS NOT NULL) DESC, k.created_at DESC, k.id DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX idx_deployments_one_active_per_app
  ON deployments (app_id)
  WHERE status IN ('pending_build', 'building', 'scanning', 'pending_deployment', 'deploying');
