DROP INDEX IF EXISTS idx_deployments_deploying_claimed_at;
ALTER TABLE deployments DROP COLUMN IF EXISTS claimed_at;
