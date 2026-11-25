-- Set by Stop on the latest attempt when it failed after applying resources,
-- so the controller tears down what that attempt left running (a
-- crash-looping Deployment, its Service and route). The row keeps its
-- 'failed' status, error and manifest. The controller clears the marker once
-- the teardown has run. A new deployment of the app cancels it.
ALTER TABLE deployments
  ADD COLUMN teardown_requested_at TIMESTAMPTZ;
