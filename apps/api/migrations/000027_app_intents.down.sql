DROP TABLE app_intents;

-- The old CHECK has no superseded.
UPDATE deployments
SET status = 'failed',
    error_message = COALESCE(error_message, 'Superseded by a newer deployment')
WHERE status = 'superseded';

ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;

ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('pending_build', 'building', 'scanning', 'pending_deployment',
                    'deploying', 'live', 'failed', 'stopped'));
