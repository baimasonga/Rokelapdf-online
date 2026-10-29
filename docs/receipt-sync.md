# Receipt Maker sync (website ⇄ Android app)

Status: implemented (27 October 2026); several businesses per person added 29 October 2026.

## Businesses come first

A person sets up a business before making anything: the Receipt Maker opens on "Set up your business" (name, and
optionally what it sells, address and phones) until there is one. Every document, number and ledger entry then
belongs to that business. A person can keep up to **10 businesses** (`src/lib/receipts/businesses.ts`), switch between
them at the top of the Receipt Maker, add one from the same list, and **archive** one (its documents and ledger are
kept; nothing new can be made until it is restored). Each business has its own profile, numbering (INV-0001 in two
businesses are two different invoices), ledger, usual prices, signature, stamp choice and footers.

On the device each business keeps its own settings (`rokela.receipts.v1:<id>`), ledger (`rokela.ledger.v1:<id>`) and,
in the app, its draft. The first business has the id `main` and keeps the keys used before there were several, so
whatever a device already held becomes its first business without being copied or changed.

## Saved documents

Every receipt, invoice and quotation made is kept **in full** (`src/lib/receipts/docs.ts`): its customer, items,
charges, payment, notes and footer, with the Stamp Studio stamp it carried (by id) and its check QR code, if any. The
pictures are not kept; making it again adds the business's signature, stamp and PAID stamp as they are then
(`src/lib/receipts/again.ts`). On the device documents are kept in IndexedDB (`rokela-receipts`, per business), as
thousands of them would not fit in localStorage.

In the sales ledger's Documents list, found by customer, number or date, a document kept in full can be **downloaded
again** (shared again in the app) or **copied** into a new one with the next number and today's date. Documents made
before this existed have only their ledger entry, so they offer neither. A copy made again prints the same check QR
code; the check's recorded file fingerprint is the first file's, so the check page shows the facts but not "Exact
match" for the new copy.

## What it does

When a person is signed in, the Receipt Maker on the website and in the Android app share, through their account, for
each of their businesses:

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
  Migration `0012` adds `business_id` to both (part of their keys); everything synced before belongs to `main`.
- **Documents** travel with their ledger entry: an entry sent with a `doc` (the full document) is stored with it and
  comes back with it. An entry sent without one (an older app cancelling a document) keeps the document already held.
- **API**: `POST /api/v1/me/receipt-sync` with `since` (the device's cursor), up to 200 changed `entries`, and
  optionally `counters` and `business: { data, at }`, all for the business named by `business_id` (`main` when
  absent). With `all: true` the answer holds every business's changed documents, each with its `business_id`, and
  `businesses` (each business's id, numbering and profile); without it, only `main`'s, in the shape older app
  versions expect, so they keep working with the first business. The answer is up to 500 changed documents (`more`
  when there are further pages), the cursor, and the numbering and profile of the business named. A business is
  added to the account by the first change sent for it; an eleventh is refused. The Android app may call it.
- **Merging** (`syncBusinesses` in `src/lib/receipts/sync.ts`, shared by both clients), business by business: a
  document's newer copy wins (by its `updatedAt`, set when it is made, cancelled or restored); numbering takes the
  higher number per kind; the business profile with the later edit time wins (archiving is an edit of the profile).
  A business set up on another device appears on this one. Nothing is ever deleted: documents are cancelled and
  businesses archived, which sync like any edit.
- **When**: shortly after a change, when the screen opens, every three minutes while it is open, and when the page
  or app comes back into view (`src/lib/receipts/use-sync.ts`).
- A device that has never synced sends everything it has; one that changes account starts again for the new
  account. A device updated to the version with businesses keeps its place separately (`rokela.receipts.sync2`), so
  it sends everything once more, which is harmless: the newer copy of each document wins.

## Access and limits

- A signed-in person with a **confirmed email**. Reading your own records always works; **sending changes needs Pro
  access** (licence, free month, or before the launch date), like the Receipt Maker itself.
- At most 10 businesses and 5,000 documents per business (the ledger's own limit); 200 documents per request.
- Each person sees only their own records; there is no sharing between accounts.

## Known limits

- The newest copy wins per document: if the same document is changed on two devices before either syncs, the later
  edit is kept and the other is lost. Documents are rarely edited after they are made, so this is acceptable.
- Two devices syncing in the same instant could, in rare cases, see a change one sync later than otherwise.
- The limit of 10 businesses is checked before a new business's first change is stored; two devices adding a business
  in the same instant could, in rare cases, leave an account with 11.
- A business the account turns away (it already holds 10, archived ones included, e.g. after two devices each added
  one offline) does not stop the others syncing: it stays on that device, its ledger says so, and it is sent in full
  again on every sync in case there is room for it. Businesses are never deleted, so there is no way to make room.
- A business set up on two devices before either syncs becomes two businesses (each device gives it its own id),
  except the very first business on each device, which is always `main`: those two are the same business, and the
  profile edited last wins.
