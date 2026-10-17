# Architecture

Rokela PDF Pro Web is one Next.js application (UI + API + background jobs) with three managed dependencies:

```
                    ┌────────────────────────── Railway ───────────────────────────┐
 Browser ──HTTPS──▶ │ Next.js app (pages, /api/v1/*, /l /d redirects, jobs)       │──▶ ClamAV (private, optional)
   │   ▲            └───────────────┬──────────────────────────────┬──────────────┘
   │   │                            │ SQL (app role, private schema) │ S3 API (signed requests)
   │   │                            ▼                              ▼
   │   └── sign-in ─────────▶ Supabase Auth         Supabase Postgres          Cloudflare R2 (private bucket)
   └──────── file bytes via short-lived signed URLs (PUT parts / GET) ──────────────────▶ R2
```

## Responsibilities

| Component               | Owns                                                                                                    | Never does                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Browser**             | PDF rendering (pdf.js) and editing (pdf-lib), upload/download of bytes via signed URLs                  | Authorization decisions, holding storage credentials          |
| **Supabase Auth**       | Accounts, passwords, email confirmation, password reset, sessions                                       | Data access — the Data API cannot see the app's schema        |
| **Next.js app**         | Every authorization decision, all database access, signing storage URLs, link resolution, rate limits   | Streaming file bytes (they go browser ⇄ R2 directly)          |
| **Postgres (`rokela`)** | Users mirror, workspaces, documents, versions, transfers, links, short links, requests, audit log, jobs | Being reachable by browsers (not exposed via the Data API)    |
| **R2**                  | Private file storage                                                                                    | Public access; anything without a valid short-lived signature |
| **ClamAV**              | Malware scanning of uploads during quarantine                                                           | Being publicly reachable                                      |

## Identity and authorization

1. The browser signs in with Supabase Auth (PKCE) and gets an access token.
2. Every API call sends `Authorization: Bearer <token>`. There are no auth cookies, so there is no CSRF surface.
3. The server verifies the token with Supabase (`GET /auth/v1/user`, cached 30 s by token digest), then mirrors the user
   and creates their personal workspace on first sign-in (`WorkspaceService.sync`, race-safe).
4. Workspace routes call `workspaces.require(user, orgId, permission)`. Non-members get **404** (no existence oracle);
   members without the permission get **403**. Roles: owner, admin, member (deny by default).
5. Operators (abuse handling, plan changes) are flagged only by deployment tooling (`npm run bootstrap:operator`).

## Data

Private schema `rokela` (configurable), applied by forward-only, checksummed migrations (`db/migrations`). The web app
connects as a least-privilege role that owns nothing; `npm run db:grants` grants exactly what `TABLE_PRIVILEGES`
lists (e.g. the audit log is insert-only, and an append-only trigger blocks updates/deletes even for the owner path).

Key records: `users`, `organizations`, `memberships`, `org_plans`, `audit_events`, `rate_limits`, and the sharing
tables — `share_documents`, `share_versions`, `share_blobs` (every stored object), `share_transfers`,
`share_transfer_files`, `share_links`, `share_comments`/`share_reviews`, `short_links` + `short_link_destinations`
(destination history), `upload_requests`/`upload_submissions`/`upload_submission_files`, `share_events`/`share_stats`
(aggregate analytics), `share_notifications`, `share_usage` (quotas), `share_jobs`, `share_brands`, `share_domains`,
`abuse_reports`, `share_attempts` (password-guess throttling).

## Documents, versions and links

```
 edit in browser ──save──▶ private DRAFT ──export──▶ immutable VERSION n ──publish──▶ "latest published"
                                                         │                                  │
                                         share link (fixed: version n)        share link (latest: follows publish)
```

- Drafts are never visible through links. Exporting freezes a version; publishing is an explicit act (optionally
  requiring an approval from a reviewer other than the author).
- **Transfers** hold arbitrary files (temporary — deleted at expiry — or persistent, a plan feature). A file can be
  replaced in place: the link keeps serving the old file until the replacement passes checks.
- **Share links** carry permission (download / view / review), optional password (scrypt), expiry, download limit,
  recipient restriction (anyone / workspace members / named verified accounts), notifications, suspend/revoke.
- **Short links** are either _public_ (marketing destinations, aliases, editable destination with an audit trail,
  folders/tags/search/bulk actions, aggregate stats) or _confidential_ (unguessable code that resolves to a share
  link or upload request; the target's own protections still apply). QR codes are generated server-side as SVG.
- **Upload requests** collect files from people without accounts; each submitter only ever sees their own files.

## File flow

1. `POST …/uploads` checks plan limits and returns an upload id and part size.
2. The browser asks for signed part URLs (`…/uploads/:id/parts`) and PUTs parts straight to R2; an interrupted upload
   resumes from the parts R2 already has.
3. `…/complete` assembles the object and puts it in **quarantine**. A background job verifies type (magic bytes),
   structure and (with ClamAV) malware, then marks it available or rejected.
4. Downloads are short-lived signed GET URLs with safe `Content-Disposition`/`Content-Type`, served by R2 (a separate
   origin from the app).

**Sending files (WeTransfer-style).** The send form (`/send` → workspace → _Send files_) creates a temporary transfer,
uploads the files (two at a time, four parts in parallel each, resumable) and then creates share links: one link in
_Get a link_ mode, or **one personal link per recipient** in _Send email_ mode, labelled with the address, so downloads
are tracked per person and one person's link can be revoked alone. With a mail provider configured
(`RESEND_API_KEY` + `MAIL_FROM`), `POST …/links/:id/email` queues a `share_email` job per recipient; the worker
derives the link token again at send time (the token is never stored in the job) and skips links revoked meanwhile.
Without one, the form shows each personal link to copy or send with the sender's own mail app. The transfer's expiry
governs every link; extending it (`PATCH …/transfers/:id`) extends them all. The recipient page previews images, PDFs
(pdf.js) and text in the page, and _Download all_ (`POST /public/shares/:token/archive`) counts as one download,
meters the bandwidth of every file and returns signed URLs that the browser streams into a ZIP (straight to disk where
the File System Access API exists, otherwise in memory up to 2 GB).

Cleanup jobs delete expired temporary files and abandoned uploads; they never delete an object still referenced by a
version, a transfer file, a replacement in progress or a submission.

## Editor

pdf.js renders pages to canvas (worker served from this origin); annotations are an SVG layer kept as plain data in
page space, so undo/redo, rotation and saving are deterministic. Export with pdf-lib copies pages in the edited order,
applies rotation and draws annotations into the page content. Tests check the exported text position against pdf.js
on every rotation and on cropped pages.

Signatures (drawn, typed or uploaded; trimmed to a transparent PNG on the device) are image annotations, embedded
once per distinct image and drawn upright for the view they were placed in. Form fields added in the editor become real
AcroForm text fields and checkboxes with unique names. Tests check signature placement against pdf.js on every rotation
and the field rectangles with pdf-lib.

Known limits: the built-in font covers Latin text (other characters become “?”); _Whiteout_ hides content visually but
does not remove it (not redaction); encrypted PDFs must be unlocked first.

## Browser tools

`/tools` lists 23 tools (`src/lib/tools/registry.ts`, the single source for titles, descriptions and routes). Each
`/tools/<slug>` page is server-rendered for search engines; one-step tools (merge, split, delete/extract pages, rotate,
add pages, crop, compress, watermark, page numbers, flatten, fill form, PDF ↔ images) run in the browser on `src/lib/tools/ops.ts`
(pdf-lib) and `src/lib/client/raster.ts` (pdf.js + canvas); several results download as a ZIP. Interactive tools
(edit, highlight, annotate, organize, sign, create form) hand the file to the editor. A file moves between pages
through IndexedDB on the same device (`src/lib/client/handoff.ts`: read once, expires after 10 minutes) — no tool
uploads anything, and the end-to-end test asserts that no non-GET request is sent while using them.

**Compress PDF** re-encodes photos and scans inside the PDF as lighter JPEGs in the browser (`compressPdf` walks the
image streams; `browserRecoder` decodes and re-encodes with canvas), scaled to the chosen level (2400 / 1600 / 1000 px
longest side). Text, fonts and vector content are not touched. Only JPEG and 8-bit gray/RGB Flate images without
predictors, decode arrays or colour-key masks are re-encoded; CMYK, indexed, JPEG 2000 and masks are left as they
are, an image is replaced only if the new one is smaller, and the original file is returned if nothing got smaller.

**Organize pages** builds a new PDF from page cards (drag-and-drop order, quarter turns, deletions, blank pages,
pages of further PDFs) with `organizePdf`. **Batch mode** runs compress, rotate, crop, watermark, page numbers,
flatten and protect on several PDFs with the same settings and returns one ZIP (same-named results are numbered).

**Protect / Unlock PDF** use `@cantoo/pdf-lib` (a maintained pdf-lib fork with encryption), imported only when
one of those tools runs (`src/lib/tools/security.ts`). Protect encrypts with AES-256; the open password is the
user's, the owner password is random and discarded, so permission restrictions cannot be lifted with the open
password. Unlock needs the current password and writes an unencrypted copy.

## Background work

Runs inside the app process (`src/instrumentation.ts`): sharing jobs every few seconds, retention every minute. Job
claims are fenced in the database, so running more than one replica is safe.
