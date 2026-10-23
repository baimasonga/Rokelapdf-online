-- A hostname may be added (pending) by several workspaces, so registering someone else's domain first no longer
-- blocks its owner; only one workspace can hold it verified. Verification is still proven by the DNS TXT record.
BEGIN;
ALTER TABLE share_domains DROP CONSTRAINT share_domains_hostname_key;
CREATE UNIQUE INDEX share_domains_verified_hostname ON share_domains (hostname) WHERE status = 'verified';
CREATE UNIQUE INDEX share_domains_org_hostname ON share_domains (org_id, hostname);
COMMIT;
