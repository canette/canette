-- A new deploy now supersedes an attempt still in progress instead of being
-- refused (#354), so an app can have several attempts in progress for a
-- while: the newest is the target in app_intents, and the builder and the
-- controller end the others as superseded.
DROP INDEX idx_deployments_one_active_per_app;
