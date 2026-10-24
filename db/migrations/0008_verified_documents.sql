-- Verified documents (docs/verified-documents.md). A record binds a public verification code to the SHA-256 of a
-- PDF stamped in the issuer's browser, plus the details the issuer chose to publish. Records are evidence: they are
-- never deleted, the digest and published details are frozen once issued, and revocation is final.
BEGIN;
CREATE TABLE verified_documents (
  id                 text NOT NULL PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-7]{20}$'),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  details            jsonb NOT NULL CHECK (jsonb_typeof(details) = 'array' AND jsonb_array_length(details) <= 8),
  issuer_name        text NOT NULL CHECK (length(issuer_name) BETWEEN 1 AND 200),
  sha256             text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status             text NOT NULL CHECK (status IN ('pending','active','revoked')),
  created_by         text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL,
  issued_at          timestamptz,
  revoked_at         timestamptz,
  revoked_by         text REFERENCES users(id),
  revocation_reason  text CHECK (revocation_reason IN ('issued_in_error','superseded','payment_reversed','fraud_suspected','other')),
  CHECK ((status = 'pending') = (sha256 IS NULL AND issued_at IS NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
CREATE INDEX verified_documents_org ON verified_documents (org_id, created_at DESC);

CREATE FUNCTION verified_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verified documents are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.code <> OLD.code OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.issuer_name <> OLD.issuer_name THEN
    RAISE EXCEPTION 'verified document identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'revocation is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'active' AND (NEW.status <> 'revoked' OR NEW.sha256 <> OLD.sha256 OR NEW.issued_at <> OLD.issued_at
     OR NEW.title <> OLD.title OR NEW.details <> OLD.details) THEN
    RAISE EXCEPTION 'an issued document can only be revoked' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending','active') THEN
    RAISE EXCEPTION 'a pending document can only be issued' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verified_documents_guard BEFORE UPDATE OR DELETE ON verified_documents
  FOR EACH ROW EXECUTE FUNCTION verified_documents_guard();
COMMIT;
