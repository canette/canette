-- Heartbeat for a deployment the controller is reconciling. Set when the row is
-- claimed (pending_deployment -> deploying) and refreshed while the reconcile
-- runs. A deploying row whose heartbeat has expired was left behind by a
-- controller that crashed or was killed, and is marked failed so the app can
-- be deployed again.
ALTER TABLE deployments
  ADD COLUMN claimed_at TIMESTAMPTZ;

CREATE INDEX idx_deployments_deploying_claimed_at
  ON deployments (claimed_at) WHERE status = 'deploying';
