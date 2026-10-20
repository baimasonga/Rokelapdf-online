# Feature status and configuration

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
