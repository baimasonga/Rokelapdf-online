-- Receipt Maker sync (docs/receipt-sync.md): a person's sales ledger, document numbering and business profile, kept
-- under their account so the website and the Android app share them. Each change gets the next value of one sequence,
-- so a device asks only for what changed since it last synced.
BEGIN;
CREATE SEQUENCE receipt_sync_seq;

CREATE TABLE receipt_sync_entries (
  user_id     text NOT NULL REFERENCES users(id),
  doc_key     text NOT NULL CHECK (length(doc_key) BETWEEN 3 AND 60),
  entry       jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  changed_at  bigint NOT NULL CHECK (changed_at >= 0),
  seq         bigint NOT NULL,
  PRIMARY KEY (user_id, doc_key)
);
CREATE INDEX receipt_sync_entries_seq ON receipt_sync_entries (user_id, seq);

CREATE TABLE receipt_sync_profiles (
  user_id      text NOT NULL PRIMARY KEY REFERENCES users(id),
  counters     jsonb NOT NULL CHECK (jsonb_typeof(counters) = 'object'),
  business     jsonb CHECK (business IS NULL OR jsonb_typeof(business) = 'object'),
  business_at  bigint NOT NULL DEFAULT 0 CHECK (business_at >= 0),
  seq          bigint NOT NULL
);
COMMIT;
