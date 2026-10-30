-- Receipt processing (docs/receipt-processing.md). A desk is an upload request whose submitters declare a bank payment
-- (with a photo of the bank receipt): students paying fees by default, or customers, members or tenants. Finance
-- matches the claims against the bank's statement and issues each confirmed payer a verified certificate. Claims are
-- financial records: never deleted, the declared payment is frozen once submitted, and clearance and rejection are final.
BEGIN;
CREATE TABLE fee_desks (
  id                   text NOT NULL PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organizations(id),
  request_id           text NOT NULL UNIQUE,
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  institution          text NOT NULL CHECK (length(institution) BETWEEN 1 AND 200),
  -- What payers are asked to identify themselves with ("Student ID", "Member ID"); null asks only for a name.
  payer_id_label       text CHECK (length(payer_id_label) BETWEEN 1 AND 40),
  certificate_title    text NOT NULL CHECK (length(certificate_title) BETWEEN 1 AND 80),
  banks                jsonb NOT NULL CHECK (jsonb_typeof(banks) = 'array' AND jsonb_array_length(banks) BETWEEN 1 AND 20),
  currency             text NOT NULL CHECK (currency IN ('NLe','USD')),
  amount_due           bigint CHECK (amount_due > 0),
  date_tolerance_days  integer NOT NULL CHECK (date_tolerance_days BETWEEN 0 AND 31),
  created_by           text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL,
  UNIQUE (id, org_id),
  FOREIGN KEY (request_id, org_id) REFERENCES upload_requests (id, org_id)
);
CREATE INDEX fee_desks_org ON fee_desks (org_id, created_at DESC);

CREATE TABLE fee_claims (
  id                    text NOT NULL PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organizations(id),
  desk_id               text NOT NULL,
  submission_id         text NOT NULL UNIQUE,
  payer_id              text CHECK (length(payer_id) BETWEEN 1 AND 60),
  payer_name            text NOT NULL CHECK (length(payer_name) BETWEEN 1 AND 200),
  bank                  text NOT NULL CHECK (length(bank) BETWEEN 1 AND 100),
  reference             text NOT NULL CHECK (length(reference) BETWEEN 1 AND 60),
  reference_key         text NOT NULL CHECK (reference_key ~ '^[A-Z0-9]{4,60}$'),
  -- bank + reference while the claim is live (submitted, matched or cleared): one live claim per bank payment.
  active_key            text,
  amount                bigint NOT NULL CHECK (amount > 0),
  paid_on               text NOT NULL CHECK (paid_on ~ '^\d{4}-\d{2}-\d{2}$'),
  status                text NOT NULL CHECK (status IN ('draft','submitted','matched','cleared','rejected')),
  status_secret_hash    text UNIQUE CHECK (status_secret_hash ~ '^[0-9a-f]{64}$'),
  match_method          text CHECK (match_method IN ('statement','manual')),
  match_note            text CHECK (length(match_note) <= 500),
  statement_line        jsonb,
  statement_line_key    text CHECK (statement_line_key ~ '^[0-9a-f]{64}$'),
  match_issue           text CHECK (length(match_issue) <= 300),
  matched_at            timestamptz,
  matched_by            text REFERENCES users(id),
  rejection_reason      text CHECK (rejection_reason IN ('not_on_statement','amount_differs','duplicate','unreadable_receipt','other')),
  rejection_message     text CHECK (length(rejection_message) <= 500),
  rejected_at           timestamptz,
  rejected_by           text REFERENCES users(id),
  verified_document_id  text UNIQUE,
  certificate           jsonb,
  cleared_at            timestamptz,
  cleared_by            text REFERENCES users(id),
  created_at            timestamptz NOT NULL,
  submitted_at          timestamptz,
  updated_at            timestamptz NOT NULL,
  CHECK ((status IN ('submitted','matched','cleared')) = (active_key IS NOT NULL)),
  CHECK ((status = 'draft') = (submitted_at IS NULL AND status_secret_hash IS NULL)),
  CHECK (status NOT IN ('matched','cleared') OR (match_method IS NOT NULL AND matched_at IS NOT NULL AND matched_by IS NOT NULL)),
  CHECK (status IN ('matched','cleared','rejected') OR (match_method IS NULL AND statement_line_key IS NULL)),
  CHECK (match_method IS DISTINCT FROM 'statement' OR statement_line IS NOT NULL),
  CHECK (statement_line_key IS NULL OR match_method = 'statement'),
  CHECK ((status = 'cleared') = (verified_document_id IS NOT NULL AND certificate IS NOT NULL AND cleared_at IS NOT NULL AND cleared_by IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL AND rejected_at IS NOT NULL AND rejected_by IS NOT NULL)),
  UNIQUE (id, org_id),
  UNIQUE (org_id, active_key),
  -- A statement line confirms one payment only.
  UNIQUE (desk_id, statement_line_key),
  FOREIGN KEY (desk_id, org_id) REFERENCES fee_desks (id, org_id),
  FOREIGN KEY (submission_id, org_id) REFERENCES upload_submissions (id, org_id),
  FOREIGN KEY (verified_document_id, org_id) REFERENCES verified_documents (id, org_id)
);
CREATE INDEX fee_claims_desk ON fee_claims (org_id, desk_id, created_at DESC);

CREATE FUNCTION fee_desks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee desks are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.request_id <> OLD.request_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.institution <> OLD.institution
     OR NEW.payer_id_label IS DISTINCT FROM OLD.payer_id_label OR NEW.certificate_title <> OLD.certificate_title OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'fee desk identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_desks_guard BEFORE UPDATE OR DELETE ON fee_desks
  FOR EACH ROW EXECUTE FUNCTION fee_desks_guard();

CREATE FUNCTION fee_claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee claims are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.desk_id <> OLD.desk_id OR NEW.submission_id <> OLD.submission_id
     OR NEW.created_at <> OLD.created_at OR NEW.payer_id IS DISTINCT FROM OLD.payer_id OR NEW.payer_name <> OLD.payer_name
     OR NEW.bank <> OLD.bank OR NEW.reference <> OLD.reference OR NEW.reference_key <> OLD.reference_key
     OR NEW.amount <> OLD.amount OR NEW.paid_on <> OLD.paid_on THEN
    RAISE EXCEPTION 'a declared payment is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('cleared','rejected') THEN
    RAISE EXCEPTION 'clearance and rejection are final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status_secret_hash IS DISTINCT FROM OLD.status_secret_hash THEN
    RAISE EXCEPTION 'the status secret is set once' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'draft' AND NEW.status NOT IN ('draft','submitted'))
     OR (OLD.status = 'submitted' AND NEW.status NOT IN ('submitted','matched','rejected'))
     OR (OLD.status = 'matched' AND NEW.status NOT IN ('cleared','rejected')) THEN
    RAISE EXCEPTION 'invalid fee claim transition' USING ERRCODE = '23514';
  END IF;
  -- A match is recorded once. Rejecting a matched claim only releases its statement line for the real payer's claim.
  IF OLD.status = 'matched' AND (NEW.match_method IS DISTINCT FROM OLD.match_method OR NEW.statement_line IS DISTINCT FROM OLD.statement_line
     OR NEW.matched_at IS DISTINCT FROM OLD.matched_at OR NEW.matched_by IS DISTINCT FROM OLD.matched_by
     OR (NEW.statement_line_key IS DISTINCT FROM OLD.statement_line_key AND NOT (NEW.status = 'rejected' AND NEW.statement_line_key IS NULL))) THEN
    RAISE EXCEPTION 'a match is recorded once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_claims_guard BEFORE UPDATE OR DELETE ON fee_claims
  FOR EACH ROW EXECUTE FUNCTION fee_claims_guard();
COMMIT;
