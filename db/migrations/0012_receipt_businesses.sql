-- Several businesses per person in the Receipt Maker (docs/receipt-sync.md): every synced document and every profile
-- (numbering and business details) now belongs to one of the person's businesses. What was synced before this belongs
-- to their first business, 'main', which is also what devices that do not know about businesses keep syncing.
BEGIN;
ALTER TABLE receipt_sync_entries
  ADD COLUMN business_id text NOT NULL DEFAULT 'main' CHECK (business_id ~ '^[a-z0-9]{1,24}$');
ALTER TABLE receipt_sync_entries DROP CONSTRAINT receipt_sync_entries_pkey;
ALTER TABLE receipt_sync_entries ADD PRIMARY KEY (user_id, business_id, doc_key);

ALTER TABLE receipt_sync_profiles
  ADD COLUMN business_id text NOT NULL DEFAULT 'main' CHECK (business_id ~ '^[a-z0-9]{1,24}$');
ALTER TABLE receipt_sync_profiles DROP CONSTRAINT receipt_sync_profiles_pkey;
ALTER TABLE receipt_sync_profiles ADD PRIMARY KEY (user_id, business_id);
COMMIT;
