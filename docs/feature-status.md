# Feature status and configuration

## University fee clearance — 30 October 2026

Team workspaces with upload requests and verified documents can open fee desks. Students claim a bank payment
(student ID, bank, reference, amount, date and a receipt photo) and get a private status link. Finance reads the
bank's CSV or .xlsx statement on their own device, sends only credit lines for matching by reference, exact amount
and date, confirms or rejects the rest by hand, and issues verified clearance certificates (server-built PDFs with a
QR code) that students download and any office can scan. One live claim per bank payment, one statement line per
claim. Claims are financial records that are never deleted. Design, data and limits: [fee-clearance.md](fee-clearance.md).

Verification: 4 API tests (full flow, duplicate references, manual confirm/reject, fee-due refusal, gating, tenant
and role visibility, database guards; also as the least-privilege app role), 9 unit tests (amounts, references,
matching rules, CSV/XLSX/date parsing, certificate determinism with a golden digest, QR decode), and a browser
smoke step (student claim, statement match, certificate download, exact-match check, no statement upload).

## Verified documents (QR) — 24 October 2026

Team workspaces with `share_verified_documents` (on by default while `TRIAL_MODE=true`) can issue PDFs with a
verification QR code on every page. The PDF is stamped and fingerprinted (SHA-256) in the issuer's browser and is
never uploaded; `/v/<code>` shows the issuer, title, published details, issue date and validity, warns when the
issuer has no DNS-verified domain, and lets anyone check a copy locally. Revocation is permanent and shown publicly
with a reason. Records are evidence: a database trigger refuses deletes, digest or detail changes after issue, and
any change after revocation. Design, privacy and threat notes and the planned fee-clearance and procurement
phases: [verified-documents.md](verified-documents.md).

Verification: 8 API tests (plan and team gating, reservation rules, tenant isolation, reserved and duplicate
labels, revocation rights, verified-domain display, database guards; also as the least-privilege app role), a
render-and-decode test proving the QR scans on every rotation and crop box, the full browser smoke test (issue,
download, anonymous check, mismatch, no upload, noindex, revoke) and 13 deliberate mutations, each caught.

## Cloudflare authentication email — 20 October 2026

Implemented the opt-in, signed Supabase Send Email Hook at `/api/auth/send-email`.
Signup, recovery, invitation, magic-link, reauthentication and secure email-change
messages use Cloudflare with the Rokela logo, navy/coral colors and Quantix Sierra
Leone ownership/contact information. Unsigned, stale, oversized or invalid requests
fail before sending; provider failures are generic non-success responses.

Activation and controlled-address acceptance are pending PDF Railway and Supabase
administrative configuration. No real email was sent or auth setting changed.
Full local check passed (231 tests, 2 skipped), production build passed, compiled
route refused unsigned requests, and desktop/mobile email previews were verified.
See [configuration, threat model, evidence and rollback](auth-email-hook.md).

## Warrior monitoring — 20 October 2026

The opt-in server adapter and operator Monitoring tab are implemented; configuration
and rollback are in [warrior-monitoring.md](warrior-monitoring.md). Production binding
is pending: the public PDF hostname alone does not configure its Railway service or
issue a fresh-MFA Warrior credential. Authentication and workspace subscription
behavior are preserved.

CI now watches the actual default branch (`claude/zealous-newton-a8gzpy`) as well
as `main`; the previous `main`-only filter skipped current release-branch pushes.

Local acceptance passed the production Next build and Chromium release workflow,
the full least-privilege suite (212 tests, 2 skipped), eight focused adapter checks
and seven security mutations. An explicitly enabled cross-repository PostgreSQL
test passed source failure, collector outage/restart, scoped ingestion, concurrent
incident deduplication, fresh recovery, two portal intents and audit verification.
These use synthetic fixtures and injected providers; they do not establish a live
PDF connection, real email delivery or physical desktop release acceptance.

The roadmap in `plan.md` remains the product baseline. This release completes the
workspace UI for short-link metadata, filters, bulk actions, CSV export, custom-domain
selection, password and account restrictions, branding, domain ownership verification,
operator abuse review, manager audit history and workspace metadata exports.

Public short URLs use `SHORT_ORIGIN/code` with six-character generated codes or custom
aliases. The previous `/l/code` URLs remain valid. Existing aliases that overlap app
routes keep the `/l/` format. Confidential links retain their unpredictable `/d/` tokens.

Upload requests are enabled by the workspace's `share_upload_requests` entitlement.
Submitters can remove and replace their own files before submitting; removals are
audited and object deletion is queued. Security-check status refreshes automatically,
and submission is disabled while uploads are running. Existing checklist, deadline,
password, file-size, storage and requester-notification policies still apply.
Request details offer Copy and Send link. Send link queues branded email invitations
for up to 20 recipients, with an optional message and requester reply-to. It requires
a verified sender account and configured email provider, uses the shared email quota,
and skips queued invitations when the request is no longer accepting submissions.

The editor supports embedded Unicode fonts, including a bundled Noto Sans font and
custom TTF/OTF uploads. Fonts must contain the requested characters. Redaction exports
all pages into a new image-only PDF, removes original searchable text and forms, and
applies black masks after rendering. It deliberately sacrifices searchable text and
vector quality. OCR offers English, French, Spanish, German and Portuguese locally.

Signature requests provide a fixed published PDF and a PDF-only return upload request.
Recipients sign with the existing editor and return the result. Declared names and
emails are not verified signer identities. This workflow does not provide certificate
signing, a regulated signature service or proof of identity. Existing page-anchored
review comments remain available through review links.

## Operator-managed plans

Plans remain operator-managed by explicit product decision. Use the existing audited
`npm run plan:set -- ...` command and entitlement overrides described in `deploy.md`.
No payment credentials or automatic charges are introduced.

## Email follow-ups

Configure Cloudflare Email Sending or Resend with a verified sender domain as described
in `deploy.md`. Cloudflare uses `MAIL_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_EMAIL_API_TOKEN` and `MAIL_FROM`. Until a complete provider configuration
is present, automatic email delivery stays disabled. Sending can optionally
schedule a reminder 24 hours before expiry; a reminder is skipped when the link has
already been downloaded, revoked or expired. Download notifications aggregate into
a daily email digest. Immediate in-app notifications remain available. Scheduled
messages use the existing database job worker and count against email quotas.

## Custom domains

The Settings page verifies DNS TXT ownership. Verification alone does not establish
HTTP routing or TLS: the operator must attach the hostname to the main Railway app,
configure the DNS routing records Railway supplies, and verify HTTPS before the
workspace uses it for short links. Keep the converter and ClamAV on private networking.

A hostname may be pending in several workspaces, but only one can verify it. Verified
domains are re-checked daily: if the TXT record is definitely gone (not a DNS outage), owners
and admins are warned in the app and by email, and after 14 days the domain returns to pending
and its short links stop resolving there. Restoring the record and checking again restores it.

## Team members

Owners and admins invite people by email; nobody joins a team until they accept, signed in
with that address confirmed. Invitations expire after 7 days and can be cancelled. The invite
form answers the same whether or not the address has an account.

Owners and admins change roles and remove members ranked at or below them; only an owner
changes or removes an owner, and a team always keeps at least one owner. Anyone can leave a
team. Files and links a removed member created stay in the workspace.

## Organization SSO: preparation only

SSO remains disabled until an identity provider and a Supabase plan supporting SAML
SSO are available. Before activation:

1. Obtain the IdP metadata URL/XML, issuer, verified domain and signing certificates.
2. Configure the SAML provider in Supabase Auth and register its ACS/entity ID with
   the IdP. Use Supabase's generated values for this project.
3. Configure allowed app redirect URLs and require administrator-controlled workspace
   membership. Never grant membership based solely on an email suffix or user metadata.
4. Migrate the local unique-email identity model before accepting SSO users: Supabase
   SSO can create a distinct user with the same email as an existing password user.
   Preserve the Supabase subject as the identity key, explicitly review account linking,
   and test existing account access. Do not silently merge by email.
5. Add the organization/provider mapping, sign-in entry point, session and membership
   tests, recovery procedure and audit events before enabling any SSO requirement.

No SSO provider credentials, account or login UI is assumed in this release.

## Export scope

Workspace managers can export document, transfer, version and link metadata as JSON
and the current audit page as CSV. Metadata export omits file bytes, credentials,
password hashes, token hashes and storage keys. Each dataset is limited to 10,000
rows and explicitly reports truncation; this is not a backup of stored files.
