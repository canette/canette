-- better-auth's `admin` plugin has always required session.impersonatedBy
-- (used to mark a session as an admin impersonating another user, and to
-- filter such sessions out of the user's own session list). The initial
-- schema migration never added it, which better-auth silently tolerated
-- until it started validating plugin schemas against the live database
-- at startup — see BetterAuthError: SCHEMA_MISMATCH.
ALTER TABLE "session" ADD COLUMN "impersonatedBy" TEXT;
