DROP INDEX IF EXISTS account_issuer_account_id_idx;
ALTER TABLE "account" DROP COLUMN issuer;
