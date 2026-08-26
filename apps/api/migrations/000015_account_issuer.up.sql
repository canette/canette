-- better-auth 1.7 scopes account identity by (issuer, accountId) instead of
-- accountId alone. Backfill values match what better-auth 1.7.1 itself
-- computes at sign-in time for each provider we use, so existing linked
-- accounts keep resolving to the same row instead of re-linking:
--   credential (email/password): "local:credential"
--   github (no built-in issuer, no id_token):  "local:oauth:github"
--   google (sets accountIssuer explicitly):    "https://accounts.google.com"
--   anything else (e.g. our generic "oidc" provider): falls back to
--     "local:oauth:<providerId>", better-auth's own synthetic fallback for
--     providers that don't set accountIssuer. If the configured OIDC IdP's
--     discovery document returns a real issuer, an existing OIDC-linked user
--     will be treated as a new sign-in on their next login and re-linked.
ALTER TABLE "account" ADD COLUMN issuer TEXT;

UPDATE "account" SET issuer = CASE "providerId"
  WHEN 'credential' THEN 'local:credential'
  WHEN 'google' THEN 'https://accounts.google.com'
  ELSE 'local:oauth:' || "providerId"
END;

CREATE UNIQUE INDEX account_issuer_account_id_idx ON "account" (issuer, "accountId");
