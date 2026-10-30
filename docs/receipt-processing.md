# Receipt processing (university fee clearance)

Status: implemented (30 October 2026). Builds on [verified documents](verified-documents.md) (phase 1) and upload
requests.

## Purpose

Students pay fees at a bank and bring the receipt to the finance office, which checks it against the bank's
records before registry, exams, hostel and library staff will serve them. Queues form, receipts are photocopied
and re-checked at every office, and forged or reused receipts are hard to spot. With a fee desk, students claim
their payment online, finance matches every claim against the bank statement in one step, and each cleared
student gets a certificate with a QR code that any office can scan to confirm.

**The bank statement is the authority, not the receipt.** A claim is cleared only when the statement shows a
credit with the claim's reference, for exactly the declared amount, within a few days of the declared date, or when
a finance officer confirms the payment by hand and records how.

## Flow

1. **Open a desk.** In a team workspace with upload requests and verified documents, a finance officer opens
   **Receipt processing** and creates a desk: what is being cleared ("2026/27 first semester tuition"), the banks students
   pay into, the currency, an optional fee due, how long claims are accepted, and how many days a statement date may
   differ from the receipt date (default 3). The desk is an upload request underneath, so its link, password,
   deadline, file checks, retention and notifications work as for any upload request.
2. **Students claim.** The desk link asks for the student's full name, student ID, bank, the transaction
   reference on the receipt, the amount and the payment date, then a photo or scan of the receipt (JPG, PNG, WebP,
   HEIC or PDF). On sending, the student gets a **private status link** (`/fees/status#…`; the secret is in the URL
   fragment, so it never reaches server logs or other sites).
   - One live claim per bank payment: a reference already claimed at the same bank (ignoring case, spaces and
     punctuation) is refused, before the student uploads anything. Unsent claims hold nothing, so an abandoned page
     does not lock the student out.
3. **Match the statement.** The officer downloads the account statement from the bank as CSV or Excel (.xlsx) and
   chooses it in the desk. It is read **on the officer's device**: the header row and the date, credit, reference
   and description columns are guessed and can be corrected; dates are day-first unless ticked otherwise. Only
   credit lines (date, amount, reference, description) are sent, in batches of 200, and only lines that confirm a
   claim are kept, on that claim, with the file's name and SHA-256. The rest of the statement is not stored.
   - A claim matches a line naming its reference (exactly in the reference column, or, for references of 6+
     characters, inside the reference or narrative), for exactly the declared amount, dated within the tolerance.
   - A line confirms one claim only, even across repeated or overlapping statements.
   - When the reference is found but the amount or date differs, the claim stays waiting and shows why.
   - The desk notes when the student ID also appears on the line (extra confidence; not required).
4. **Decide the rest.** The officer can **confirm** a waiting claim by hand (a note on how is required and kept in
   the audit log; the certificate then says the finance office confirmed the payment) or **reject** a waiting or
   confirmed claim with a reason and an optional message to the student. Rejection is final and frees the bank
   reference, and any statement line, for the person who really paid.
5. **Issue certificates.** **Issue certificates** clears every confirmed claim, 50 per request. A claim below the
   fee due is skipped. For each, the server builds an A4 PDF (institution, what was cleared, student name and ID,
   amount, payment date, bank and reference, date cleared, and a QR code for `/v/<code>`) and registers it as an
   active [verified document](verified-documents.md), with the student name, student ID, amount, payment date
   and how the payment was confirmed as published details.
6. **Students download; offices scan.** The student's status page shows the progress, the rejection reason, or a
   **Download certificate** button. Anyone scanning the QR code sees the verification page; **Check your copy**
   confirms a PDF is the issued one. Revoking the verified document (for example, payment reversed) shows on both
   pages.

## Data

Migration `0013` adds two tables. Both are financial records: never deleted (triggers refuse DELETE; the app role
has SELECT, INSERT and UPDATE only).

- `fee_desks`: id, org_id, request_id (the upload request), title, institution (workspace name snapshot), banks,
  currency, amount_due (minor units), date_tolerance_days, created_by, created_at.
- `fee_claims`: the declared payment (student ID and name, bank, reference and its normalized key, amount in minor
  units, payment date), status (`draft` → `submitted` → `matched` → `cleared`, or `rejected`), `active_key` (bank +
  reference while live, unique per workspace), the status-link secret hash, the match (method, note, statement
  line and its fingerprint, unique per desk), the latest match issue, rejection reason and message, and the
  certificate (verified document id and the facts printed on it).

The trigger freezes the declared payment once submitted, allows only the transitions above, records a match once
and makes clearance and rejection final.

Certificates are not stored. They are rebuilt from the recorded facts for each download, and the server refuses
to serve one whose SHA-256 differs from the registered digest. `buildFeeCertificate` is deterministic, and a
golden digest in `tests/unit/receipt-processing.test.ts` fails if a code or dependency change would alter the bytes;
changing the layout therefore needs a plan for certificates already issued.

## Security and privacy

- **Claims and receipts** are visible only to the desk's creator and the workspace's owners and admins, like
  upload request submissions. Other members see that the desk exists and its counts.
- **The status link** is the student's only credential: 256 random bits, stored hashed, sent in a header. Anyone
  holding it can see that claim and download its certificate; nothing else.
- **Public certificate details** are the student's name and ID, the amount and payment date. They are needed by
  the offices that check clearance, and are reachable only through the unguessable code printed on the
  certificate. The bank reference is printed on the certificate but not published.
- **Statements** stay on the officer's device apart from credit lines sent for matching; only matched lines are
  stored. Statement imports are audited with the file's SHA-256 and the counts.
- **Known limits.** Students' names, IDs and receipts are self-declared. Someone who learns another person's bank
  reference could claim it first. The statement then confirms the payment (it does not identify the student), so
  officers should look at the receipt photo and the "student ID found" note, and reject a wrong claim. The real
  payer can then claim. A certificate proves who issued it and that it is unaltered, not that the facts are true
  beyond what the finance office checked.
- **Old Excel files** (.xls) are not read; save them as .xlsx or CSV.

## API

Workspace (`/api/v1/workspaces/:orgId/sharing`): `GET|POST fee-desks`, `GET fee-desks/:id`,
`POST fee-desks/:id/statements`, `POST fee-desks/:id/certificates`, `POST fee-claims/:id/approve`,
`POST fee-claims/:id/reject`, `GET fee-claims/:id/certificate`. Public: the desk is an upload request
(`/api/v1/public/upload-requests/:token/…`, with a `payment` object when starting a submission);
`GET /api/v1/public/fee-claims/status` and `GET /api/v1/public/fee-claims/certificate` with the `x-claim-secret`
header.

Audit actions: `fee.desk.created`, `fee.claim.submitted`, `fee.statement.imported`, `fee.claim.approved`
(the note is the reason), `fee.claim.rejected`, `fee.claim.cleared`, plus `share.verification.issued` for each
certificate.
