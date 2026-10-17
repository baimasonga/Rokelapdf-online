# Security model

## Assets

User documents and transferred files (R2), link and request tokens, account sessions (Supabase), the database
(workspaces, links, audit log), and storage/database credentials (Railway variables only).

## Trust boundaries and controls

| Boundary               | Threat                                            | Control                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → API          | Forged or stolen session, CSRF                    | Bearer token verified with Supabase on each request (30 s cache by digest); no auth cookies, so no CSRF; tokens are never logged                                                                                                       |
| Browser → API          | Cross-tenant access, enumeration                  | Every workspace call authorizes membership and role server-side; non-members get 404; strict schemas reject unknown fields                                                                                                             |
| Page content           | XSS stealing the session (stored in localStorage) | Per-request nonce CSP with `strict-dynamic`, no `unsafe-inline`/`unsafe-eval` scripts, `connect-src` limited to self + Supabase + R2; React escaping, no `dangerouslySetInnerHTML`; `frame-ancestors 'none'`                           |
| Recipient → share link | Guessing links, password guessing                 | HMAC-derived tokens (256-bit for share links and upload requests, 96-bit codes for confidential short links); scrypt-hashed passwords with per-link attempt lockout; per-IP rate limits on every public route                          |
| Recipient → files      | Serving active content from our origin            | Files come only from R2 (separate origin) via short-lived signed URLs with forced `Content-Disposition` and `nosniff`; the app origin never serves user bytes                                                                          |
| Uploads                | Malware, disguised file types, storage exhaustion | Quarantine until checked (type by magic bytes, structure, ClamAV); plan quotas enforced server-side before signing; a failed check rejects the file                                                                                    |
| Short links            | Phishing redirects, open redirect                 | Public links: http(s) destinations only (no `javascript:`/`data:`), operator-blocked hosts, abuse reports, operator suspension; confidential links resolve only to our own share/request pages; unlock page shows the destination host |
| App → Postgres         | SQL injection, over-privileged app                | Parameterized queries; private schema not exposed by Supabase's Data API; least-privilege role that owns nothing; append-only audit log                                                                                                |
| Operators              | Silent changes                                    | Operator flag only via deployment tooling; plan changes and holds require a reason and write an audit event in the same transaction                                                                                                    |
| Configuration          | Weak production setup                             | Startup fails closed: R2 required, strong `SHARING_SECRET`, HTTPS origins, ClamAV unless explicitly disabled                                                                                                                           |

## Honest limits (also shown to users)

- View-only access cannot stop screenshots, photos or copying. Revoking stops future access; it cannot recall copies.
- A short URL is not access control; confidential links rely on the share link's own protections.
- _Whiteout_ in the editor covers content visually; the text underneath remains in the file. It is not redaction.
- Names typed by recipients and submitters are unverified and labelled as such.
- Signatures made in the editor are images placed on the page, not cryptographic (certificate) signatures.
- Browser tools never upload files; a file handed from a tool page to the editor waits in this browser's IndexedDB for at
  most 10 minutes and is deleted when read.
- Session tokens live in browser storage (Supabase default); the CSP is the main XSS mitigation.

## Retention

- Temporary transfers: files are deleted at expiry (plan-limited retention); persistent transfers are kept until deleted.
- Upload requests: submitted files are deleted after the request's retention period, or with the request.
- Abandoned uploads are cleaned up; R2 lifecycle aborts incomplete multipart uploads after 2 days.
- Cleanup never deletes an object still referenced by a version, transfer file, pending replacement or submission.
- Analytics are aggregate; detailed access events are kept for `EVENT_RETENTION_DAYS` (default 180).
- Licensing/plan problems degrade features; they never delete or lock user documents.

## Verification

`npm run check` (unit, API and security tests, including negative paths), `npm run test:approle` (same suite as the
least-privilege role), `npm run e2e` (real browser against a production build with the production CSP).
