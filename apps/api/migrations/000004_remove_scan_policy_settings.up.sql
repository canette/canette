DELETE FROM admin_settings WHERE key IN (
  'security.scan_enabled',
  'security.scan_mandatory',
  'security.scan_fail_severity'
);
