-- Receipt checks (docs/receipt-checks.md). A business making a receipt, invoice or quotation in the Receipt Maker can
-- register its main facts; the QR code printed on the document opens a public page showing them, so a customer,
-- landlord or auditor can see that the document was really issued and has not been cancelled. Records are evidence:
-- never deleted, the facts are frozen, the PDF digest is set once, and cancellation is final.
BEGIN;
CREATE TABLE receipt_checks (
  id             text NOT NULL PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-7]{16}$'),
  kind           text NOT NULL CHECK (kind IN ('receipt','invoice','proforma')),
  business_name  text NOT NULL CHECK (length(business_name) BETWEEN 1 AND 120),
  number         text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  issued_on      date NOT NULL,
  currency       text NOT NULL CHECK (currency IN ('NLe','USD')),
  total          numeric(16,2) NOT NULL CHECK (total >= 0),
  customer_name  text CHECK (length(customer_name) BETWEEN 1 AND 120),
  sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status         text NOT NULL CHECK (status IN ('active','cancelled')),
  created_at     timestamptz NOT NULL,
  cancelled_at   timestamptz,
  cancel_reason  text CHECK (cancel_reason IN ('issued_in_error','replaced','refunded','other')),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX receipt_checks_user ON receipt_checks (user_id, created_at DESC);

CREATE FUNCTION receipt_checks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt checks are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind
     OR NEW.business_name <> OLD.business_name OR NEW.number <> OLD.number OR NEW.issued_on <> OLD.issued_on
     OR NEW.currency <> OLD.currency OR NEW.total <> OLD.total OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'receipt check facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'the digest is set once' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.status <> 'cancelled' OR NEW.cancelled_at <> OLD.cancelled_at OR NEW.cancel_reason <> OLD.cancel_reason) THEN
    RAISE EXCEPTION 'cancellation is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_checks_guard BEFORE UPDATE OR DELETE ON receipt_checks
  FOR EACH ROW EXECUTE FUNCTION receipt_checks_guard();
COMMIT;
