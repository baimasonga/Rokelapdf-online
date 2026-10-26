# Receipt checks (QR code on Receipt Maker documents)

Status: implemented (26 October 2026).

## Purpose

A small business gives a customer a receipt, an invoice or a quotation made in the Receipt Maker. Later someone has
to trust it: a customer claiming a refund, a landlord or school accepting proof of payment, an employer reimbursing an
expense, or the business itself facing a forged or altered copy. With "QR code to check it" ticked, the document
carries a QR code. Anyone who scans it sees, on `rokelapdf.com/receipts/<code>`, the facts the business registered
when it made the document, and whether the business has cancelled it since.

These are business records, not NRA fiscal receipts. GST-registered businesses must still issue receipts from an
approved electronic cash register, and the check page says so.

## Flow

1. The person ticks **QR code to check it** (remembered in this browser). The preview shows a placeholder code.
2. On **Download** or **Share**, after the Pro check, the browser needs a signed-in account with a confirmed email and
   Pro access (licence, free month, or before the launch date). It registers the facts:
   `POST /api/v1/me/receipt-checks` with kind, business name, number, date, currency, total and the customer's name
   if there is one. The server returns a 16-character code (80 bits, from the 32-letter alphabet) and the page URL.
3. The browser draws the QR code and the code beside the signature, builds the PDF, and sends only its SHA-256
   (`POST …/:id/digest`, once). The PDF itself never leaves the device.
4. Downloading the same document again gives the same file (the PDF dates are fixed to the document date), so the
   same check is reused. If the facts or the look changed, a new check is registered and the previous check for the
   same number is cancelled as "replaced", so only the latest file reads as valid.
5. Anyone opens the page (no account): document type, business, number, date, total, customer, code and status.
   **Check a PDF copy** hashes a chosen PDF on the viewer's device and compares it with the registered digest.
6. The business can cancel a check (`POST …/:id/cancel`) with a reason: `issued_in_error`, `replaced`, `refunded`,
   `other`. Cancellation is final, and the page then says not to rely on the document.

## Data

Table `receipt_checks` (migration `0010`): id, user_id, code (unique), kind, business_name, number, issued_on,
currency, total, customer_name, sha256 (set once), status (`active` → `cancelled`), created_at, cancelled_at,
cancel_reason. A trigger refuses deletion, changed facts, a second digest and undoing a cancellation. App role
privileges: SELECT, INSERT, UPDATE.

## Security and privacy

- **Only these facts are public**, and only to someone holding the code, which is printed on the document by design.
  The page never shows the issuer's account, email or internal ids. Item lines, prices, phone numbers and
  addresses are never sent. The customer's name is sent because it is what lets a customer prove the receipt is
  theirs; the option says so before it is ticked.
- **The business name is self-declared.** The page says Rokela PDF has not checked who runs the business. A check
  proves that the account which made the document registered these facts, and when, not that the business is
  who it claims to be.
- **Limits**: a confirmed email and Pro access to register; 1,000 registrations per person per day; public lookups
  are rate-limited per IP like other public routes, and unknown and malformed codes are the same 404. Pages are not
  indexed by search engines.
- **The digest proves integrity, not truth.** A matching file is the one the business made. A printed copy cannot be
  hashed; the person compares the printed facts with the page instead.
