ALTER TABLE apps ADD COLUMN password_gate_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE apps ADD COLUMN password_gate_username TEXT;
ALTER TABLE apps ADD COLUMN password_gate_password_hash TEXT;
