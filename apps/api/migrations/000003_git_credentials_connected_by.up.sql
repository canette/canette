ALTER TABLE git_credentials ADD COLUMN connected_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL;
