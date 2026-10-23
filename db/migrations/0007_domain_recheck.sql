-- Verified custom domains are re-checked daily. When the TXT record is gone the domain keeps working while the
-- workspace is warned; after the grace period it returns to pending, so a lapsed domain cannot stay attached to a
-- workspace (or block a new owner) indefinitely.
BEGIN;
ALTER TABLE share_domains ADD COLUMN missing_since timestamptz;
ALTER TABLE share_domains ADD CONSTRAINT share_domains_missing_verified CHECK (missing_since IS NULL OR status = 'verified');
CREATE INDEX share_domains_recheck ON share_domains (checked_at) WHERE status = 'verified';
COMMIT;
