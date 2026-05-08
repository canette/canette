INSERT INTO admin_settings (key, value, updated_at) VALUES
  ('security.scan_enabled',     'true',     CURRENT_TIMESTAMP),
  ('security.scan_mandatory',   'false',    CURRENT_TIMESTAMP),
  ('security.scan_fail_severity', 'HIGH',   CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;
