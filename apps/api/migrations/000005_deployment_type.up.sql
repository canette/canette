ALTER TABLE apps
  ADD COLUMN deployment_type TEXT NOT NULL DEFAULT 'web'
    CHECK (deployment_type IN ('web', 'private', 'cronjob'));
