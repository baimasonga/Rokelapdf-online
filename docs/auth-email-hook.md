# Cloudflare authentication email hook

## Decision and trust boundary

Supabase remains the account, token, expiry, PKCE and session authority. An opt-in
Next.js POST endpoint `/api/auth/send-email` verifies Supabase Standard Webhooks
signatures over the original bounded body before interpreting recipients or tokens.
Only the configured Cloudflare sender is used. No Supabase service-role key is needed.
The hook sends synchronously and acknowledges only Cloudflare acceptance; this is
not proof of inbox delivery. It never stores or logs tokens, recipients or payloads.

Threats: forged requests/open relay (signed payload required), stale replay (verifier's
five-minute window), malicious redirects (exact public-origin match), HTML injection
(escaped values), provider failure (generic non-success, never false acknowledgement),
and resource abuse (64 KiB streamed cap, short Cloudflare timeout). Signed retries
inside the timestamp window can resend an email. Cloudflare does not document
idempotency: an accepted request with a lost response can produce duplicate emails.
This endpoint does not promise exactly-once delivery. Tokens retain Supabase expiry
and single-use checks. Do not log request bodies in Railway, proxies or monitoring.

## Activation order

1. Deploy this source with existing verified Cloudflare Email Sending configuration:
   `MAIL_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`,
   `MAIL_FROM` (for example `Rokela PDF <your-verified-address>`), `SUPABASE_URL`,
   and HTTPS `PUBLIC_ORIGIN`. Email Routing/forwarding alone is not outbound sending.
2. In Supabase Authentication → Hooks, create an HTTPS **Send Email** hook targeting
   `https://rokelapdf-online-production.up.railway.app/api/auth/send-email`.
   Copy the generated signing secret securely into the PDF Railway service as
   `AUTH_EMAIL_HOOK_SECRET` (format `v1,whsec_<base64>`). Never paste it into chat.
3. Redeploy the PDF service, then enable the hook in Supabase. Keep the Email auth
   provider and email confirmations enabled. No SMTP password is required for this hook.
4. Test signup, confirmation completion on the originating device, password recovery,
   and both sides of secure email change using addresses you control. Inspect Cloudflare
   acceptance/activity and Supabase Auth errors; never copy token URLs into logs.
5. The hook renders templates in this repository, including logo, navy/coral colors,
   ownership and support details. Supabase dashboard email templates do not render hook
   messages. Sender domain DNS authentication and provider sending limits still apply.

Supported actions: signup, recovery, invite, magiclink, reauthentication and email_change.
Secure email change sends current-address `token_hash_new` and new-address `token_hash`,
as specified by Supabase. Reauthentication uses a code. Unknown actions fail closed:
leave optional security-notification email types disabled until their payloads are
explicitly supported. Redirects must share `PUBLIC_ORIGIN`; add no wildcard domains.

Rollback: disable the hook in Supabase first and restore a working SMTP sender before
removing its Railway secret/source. Supabase's default sender is not a production
fallback. Do not disable email confirmation to work around delivery problems.

## Evidence and limits

Verification on 20 October 2026:

- `npm run check` with isolated local PostgreSQL: 231 passed, 2 skipped;
  formatting, lint (17 existing warnings, no errors) and TypeScript passed.
- 17 new hook tests cover signatures, tampering, timestamp freshness, bounded bodies,
  redirects, action/token mapping, secure email change and provider failures.
- `npm run build` passed and included `/api/auth/send-email`.
- The compiled route returned 401 for unsigned POST and 405 for GET over local HTTP,
  using synthetic configuration; no provider call was made.
- Desktop (760 px) and phone (390 px) Chromium renders had no horizontal overflow.
  The public logo URL returned HTTP 200 with bytes matching the checked-in brand asset.

Automated delivery tests use synthetic signed payloads and injected Cloudflare responses;
no real email was sent. Deployment, hook enablement, domain authentication and inbox
acceptance require separate live verification. Current environment lacks PDF Railway
and Supabase administrative access, so activation is not established by source tests.

References: [Supabase Send Email Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook),
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks),
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/).
