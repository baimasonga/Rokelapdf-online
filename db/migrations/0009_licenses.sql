-- Yearly licences for the paid tools (src/lib/licensing.ts; docs/licensing.md), one per person and tied to their
-- email, so an operator can grant one before the person first signs in. Changed only by operators through tooling
-- with the owner connection; the web app only reads it.
BEGIN;
CREATE TABLE user_licenses (
  email        text PRIMARY KEY CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz NOT NULL CHECK (valid_until >= valid_from),
  updated_at   timestamptz NOT NULL,
  updated_by   text NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500)
);
COMMIT;
