-- Tracks the LIVE pod health of an app, separate from deployments.status
-- (which only ever records whether a deploy OPERATION succeeded). A deploy
-- can succeed and the app can still crash minutes or days later — this
-- column is what the controller's background health watcher updates as it
-- observes pod state, independent of any deploy being triggered.
--
-- 'unknown' (not a boolean) deliberately covers apps with no meaningful
-- runtime health signal yet: cronjobs (no long-running pod), stopped apps,
-- and the brief window right after a deploy goes live before the watcher's
-- first observation arrives.
ALTER TABLE apps ADD COLUMN runtime_health TEXT NOT NULL DEFAULT 'unknown'
  CHECK (runtime_health IN ('healthy', 'unhealthy', 'unknown'));
ALTER TABLE apps ADD COLUMN runtime_health_reason TEXT;
ALTER TABLE apps ADD COLUMN runtime_health_updated_at TIMESTAMPTZ;
