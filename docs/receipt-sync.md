# Receipt Maker sync (website ⇄ Android app)

Status: implemented (27 October 2026).

## What it does

When a person is signed in, the Receipt Maker on the website and in the Android app share, through their account:

- the **sales ledger**: every receipt, invoice and quotation made (with cancellations and payments against invoices);
- the **numbering** of each kind of document, so two devices never hand out the same number;
- the **business profile** (name, address, phones, email, TIN, colours). The **logo stays on each device**: a
  logo can be larger than the API's 64 KB request limit.

Signed out, everything stays on the device as before. The ledger screens say which is the case ("Synced with your
account 2 min ago" or "Kept in this browser/phone only. Sign in…").

## How it works

- **Server**: migration `0011` adds `receipt_sync_entries` (one row per document per person, keyed by kind and
  number, with the client's change time) and `receipt_sync_profiles` (numbering and business profile). Every change
  takes the next value of one sequence (`receipt_sync_seq`), so a device asks only for what changed since its cursor.
- **API**: `POST /api/v1/me/receipt-sync` with `since` (the device's cursor), up to 200 changed `entries`, and
  optionally `counters` and `business: { data, at }`. The answer is up to 500 changed documents (`more` when there
  are further pages), the cursor, the numbering and the business profile. The Android app may call it.
- **Merging** (`src/lib/receipts/sync.ts`, shared by both clients): a document's newer copy wins (by its
  `updatedAt`, set when it is made, cancelled or restored); numbering takes the higher number per kind; the business
  profile with the later edit time wins. Nothing is ever deleted: documents are cancelled, which syncs like any edit.
- **When**: shortly after a change, when the screen opens, every three minutes while it is open, and when the page
  or app comes back into view (`src/lib/receipts/use-sync.ts`).
- A device that has never synced sends everything it has; one that changes account starts again for the new
  account.

## Access and limits

- A signed-in person with a **confirmed email**. Reading your own records always works; **sending changes needs Pro
  access** (licence, free month, or before the launch date), like the Receipt Maker itself.
- At most 5,000 documents per person (the ledger's own limit); 200 per request.
- Each person sees only their own records; there is no sharing between accounts.

## Known limits

- The newest copy wins per document: if the same document is changed on two devices before either syncs, the later
  edit is kept and the other is lost. Documents are rarely edited after they are made, so this is acceptable.
- Two devices syncing in the same instant could, in rare cases, see a change one sync later than otherwise.
