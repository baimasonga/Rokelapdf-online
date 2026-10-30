# Verified documents (QR verification)

Status: phase 1 implemented (24 October 2026). University fee clearance implemented (30 October 2026; see
[fee-clearance.md](fee-clearance.md)). Procurement bid opening is outlined, not built.

## Purpose

Institutions in Sierra Leone issue paper and PDF documents that others must trust: fee clearance after a
bank payment, certificates and transcripts, letters, tender documents, bid opening records and award notices.
Forgery and "is this the latest version?" disputes cost time and create queues. A verified document carries a
QR code; anyone who scans it sees, on `rokelapdf.com`, who issued it, the public details the issuer chose, and
whether it is still valid. Anyone holding the PDF can also confirm that their copy is byte-for-byte the issued
one, without uploading it.

## Phase 1 flow

1. A workspace member with the `share_verified_documents` plan feature opens **Verified documents**, chooses a
   PDF, enters a title and up to eight public details (label and value, for example `Student ID` / `FBC/2024/123`).
2. The server reserves an unguessable code (`POST …/verified-documents`, status `pending`) and returns the
   verification URL `PUBLIC_ORIGIN/v/<code>`.
3. The browser stamps a QR code for that URL and the text "Verify at …" on every page (bottom right), computes
   the SHA-256 of the stamped PDF and sends only the digest (`POST …/:id/issue`). The PDF itself never leaves
   the device, matching the rest of the browser tools. The record becomes `active`; the issuer downloads the
   stamped PDF.
4. Anyone opens `/v/<code>` (no account): issuer, title, details, issue date and status (valid or revoked, with
   the revocation date and reason category). **Check your copy** hashes a chosen PDF in the browser and compares
   it with the issued digest: "exact match" or "does not match (altered, re-saved or a different document)".
5. The creator or a workspace manager (owner/admin) can revoke a document with a reason category
   (`issued_in_error`, `superseded`, `payment_reversed`, `fraud_suspected`, `other`). Revocation is permanent and
   audited; the verification page shows it immediately.

## Data

Table `verified_documents` (migration `0008`): id, org_id, code (unique), title, details (JSON array of at most
eight label/value pairs), issuer_name (workspace name snapshot at reservation), sha256 (set at issue), status
(`pending` → `active` → `revoked`), created_by, created_at, issued_at, revoked_at, revoked_by,
revocation_reason. App role privileges: SELECT, INSERT, UPDATE (no DELETE: records are evidence).

## Security and privacy

- **Codes** are 20 characters from a 32-letter alphabet (100 bits), generated server-side; they cannot be
  enumerated. The code is printed on the document by design, so it is not a password; it only reveals what the
  issuer chose to publish.
- **Only chosen details are public.** The page never shows the creator's identity, workspace members, other
  documents or internal ids. Issuers are told not to publish sensitive data (amounts and full names only when
  needed). Lengths are bounded; text is rendered as text, never as HTML.
- **Issuer identity is the main trust risk**: anyone can name a workspace "University of …". The page therefore
  shows the issuer name snapshot together with the workspace's DNS-verified custom domains (existing domain
  ownership verification). With no verified domain it states plainly that the issuer's identity has not been
  verified by Rokela PDF. Operator-verified organizations are a later addition.
- **The digest proves integrity, not truth.** A matching copy proves the PDF is the one the issuer stamped; the
  issuer remains responsible for its content. A PDF re-saved or printed and scanned will not match; the QR
  status check still works for paper.
- **Pending reservations** are never public, can be issued only by their creator within one hour, and an issued
  digest can never be replaced.
- Public lookups are rate-limited per IP like other public routes; unknown, pending and other-tenant codes all
  return the same 404.
- Issue and revoke are audited (`share.verification.reserved`, `.issued`, `.revoked`); public views are not
  recorded per viewer.

## Later phases (not built)

### University fee clearance (built)

Implemented as described in [fee-clearance.md](fee-clearance.md). The original outline: students submit a bank receipt photo and structured fields (student ID, bank, transaction reference, amount,
date) through an upload-request style form; duplicate references are refused. Finance reviews a queue, then
uploads the bank's statement export (CSV/Excel) for automatic matching by reference, amount and date. Each
cleared student receives a fee clearance certificate issued through phase 1, which registry, exams, hostel and
library staff check by scanning. The bank statement, not the receipt image, is the authority.

### Procurement bid opening

Interim (paper bids): bid opening records, attendance lists, notices and award letters are generated and issued
through phase 1 with committee signatures. Later: sealed electronic submission with a deadline lock, timed
submission receipts (digest + time, verified by QR), opening only after a committee quorum approves, a live
opening session and an automatically generated, signed opening record sent to all bidders; then evaluation and
award workflows. Electronic submission requires confirmation that procurement rules permit it, and a strong
"nobody can open early" guarantee needs committee-held keys rather than server access control alone.
