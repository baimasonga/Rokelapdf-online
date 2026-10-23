# Deploying: Supabase + Cloudflare R2 + Railway

## Current free trial

`TRIAL_MODE` defaults to `true` during the user trial. Every registered workspace
has access to upload requests, signature collection, persistent sharing, branding,
custom domains and advanced analytics without an operator-managed paid plan.
This applies equally to existing workspaces and newly registered users. Workspaces without a paid plan display **Free trial**.
Existing storage, file-size, retention, email and API limits still apply; trial
mode does not disable authentication, workspace isolation or malware checks.
Custom domains still require ownership verification and DNS configuration.

Set `TRIAL_MODE=false` and redeploy to end this temporary full-feature access.
Paid workspace grants remain unchanged. Trial mode does not write permanent plan
grants, and existing requests are not deleted when the trial ends. Keep this flag
consistent between Railway and any Cloudflare backup. No new plan-selection UI or
billing flow is introduced by the trial.

Nothing here is created automatically: you create the three accounts' resources, then Railway deploys from GitHub.
Status: the configuration is tested locally (production build, production CSP, PostgreSQL, browser end-to-end test);
the R2 and Supabase connections are exercised for the first time on your first deploy — use the checklist in §5.

## 1. Supabase (accounts + database)

1. Create a project (choose the region closest to your users and to your Railway region).
2. **Database role**: SQL editor → run [`supabase-setup.sql`](supabase-setup.sql) with your own password.
3. **CA certificate**: Settings → Database → _SSL Configuration_ → download the certificate. Its contents become
   `DATABASE_CA_PEM` (verified TLS). Keep _Enforce SSL_ on.
4. **Connection strings**: Settings → Database → _Connection pooling_ → **Session pooler** (port 5432, IPv4):
   - `DATABASE_MIGRATE_URL`: user `postgres.<project-ref>` with the database password — used only by the pre-deploy step.
   - `DATABASE_URL`: user `rokela_app.<project-ref>` with the password from step 2 — used by the running app.
5. **Auth** → _URL configuration_: Site URL `https://<your app domain>`; Redirect URLs `https://<your app domain>/**`.
   **Auth** → _Providers → Email_: keep _Confirm email_ on; set _Minimum password length_ to at least 10.
   **Auth** → _SMTP_: configure your own sender for production (Supabase's built-in sender is rate-limited).
6. Settings → API: copy the **Project URL** (`SUPABASE_URL`) and the **publishable key** (`SUPABASE_PUBLISHABLE_KEY`).
   Never put the service-role / secret key anywhere — the app does not need it.

## 2. Cloudflare R2 (files)

1. Create a **private** bucket (e.g. `rokela-files`): no public access, no `r2.dev` URL.
2. _Manage R2 API tokens → Create token_: **Object Read & Write**, limited to that bucket → `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`. Endpoint: `https://<account-id>.r2.cloudflarestorage.com` → `R2_ENDPOINT`.
3. Bucket → Settings → **CORS policy** (browsers upload and download directly):
   ```json
   [
     {
       "AllowedOrigins": ["https://<your app domain>"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["content-type", "content-length"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 600
     }
   ]
   ```
4. Bucket → **Object lifecycle rules**: abort incomplete multipart uploads after 2 days. Leave versioning off (deleted
   files must really go away).

## 3. Railway (app)

Use three separate services in the **same Railway project and environment**. Service display names do not
establish which software runs there; verify the build and runtime logs.

| Service   | Root directory  | Build/start                                                             | Connections                                              |
| --------- | --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Main app  | `/`             | `npm run build`, pre-deploy `npm run deploy:prepare`, start `npm start` | Supabase, PostgreSQL, R2, converter, ClamAV              |
| Converter | `/converter`    | auto-detected `Dockerfile`; leave command overrides empty               | private HTTP port `8080`; shared `CONVERTER_TOKEN`       |
| ClamAV    | `/infra/clamav` | auto-detected `Dockerfile`; leave command overrides empty               | private TCP port `3310`; no account, API key or database |

Railway's Settings UI now reports that new services cannot opt into legacy Config as Code. Configure these
settings directly for new services; clear the Railway Config File field on the converter and ClamAV services.
The JSON files remain for existing legacy deployments. Never put a JSON filename in Root Directory. A root
of `/infra/clamav` automatically detects the `Dockerfile` inside that directory.

- Main app: health check `/api/v1/health`; add a public/custom domain under Networking.
- Converter: health check `/health`; `HOST=::`, `PORT=8080`; no public domain is needed. Generate a secret
  `CONVERTER_TOKEN` with `openssl rand -base64 48`, and set the exact same token on the main app. On the app,
  `CONVERTER_URL=http://<actual-converter-private-hostname>:8080`. Verify logs say `listening`, not Next.js.
  Optional variables: `CONVERTER_CONCURRENCY` (2), `CONVERTER_TIMEOUT` (120 seconds),
  `CONVERTER_MAX_BYTES` (52428800), `CONVERTER_MAX_PAGES` (200), `CONVERTER_MEMORY_MB` (3072 per-job
  address-space limit). Set the Railway memory allocation for the total process workload; that per-job limit
  does not allocate container memory. Start with one concurrent job on small instances and measure usage.
- ClamAV: allow about 2 GB of memory; no public domain or HTTP health check. On the **main app** set
  `CLAMD_HOST=<actual-clamav-private-hostname>` (no scheme or port), `CLAMD_PORT=3310`, and remove
  `MALWARE_SCAN_DISABLED`. Logs should end with `clamd started`; initial definition updates can take time.

### Verify the running system

After deploying the code, run in the **main app's Railway shell** (uses its existing variables):

```bash
npm run check:services
# Or isolate the current conversion failure:
npm run check:services -- --only=converter
```

This checks the app database connection/schema, Supabase Auth endpoint/key, R2 bucket access, an actual ClamAV
INSTREAM scan, converter identity/dependencies, and a real synthetic RTF-to-PDF conversion through LibreOffice.
It doesn't modify database records or stored files and never prints credentials or response bodies. It does not
verify browser CORS, user-specific authorization or email delivery; use the checklist below for those.
A skipped optional service is not a passing check. Converter identity requires the updated converter image.

The main app logs every failed converter HTTP response with `reason`, `status`, `host` and `request_id`.
The converter logs the same ID and its worker's exit code/exception class. No document text or tokens are logged.
`authentication` means 401/403; `wrong_service_or_route` means 404; `http` with 500 means conversion failed.
If the app logs a response but the intended converter logs no request with that ID, check which private hostname
and deployment the app is actually reaching. Do not infer a service's identity from its display name.

### App variables (mark secrets as secret)

| Variable                                                               | Value                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                             | `production`                                                                                       |
| `PUBLIC_ORIGIN`                                                        | `https://<your app domain>`                                                                        |
| `SHORT_ORIGIN` (optional)                                              | a separate short domain for public short links, e.g. `https://rkl.to`                              |
| `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `DATABASE_CA_PEM`              | from §1                                                                                            |
| `APP_DB_ROLE`                                                          | `rokela_app`                                                                                       |
| `DB_SCHEMA` (optional)                                                 | `rokela` (default)                                                                                 |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                             | from §1                                                                                            |
| `SHARING_SECRET`                                                       | `openssl rand -base64 48` — signs link tokens; changing it invalidates every link                  |
| `STORAGE`                                                              | `r2`                                                                                               |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from §2                                                                                            |
| `CLAMD_HOST`, `CLAMD_PORT`                                             | `<clamav>.railway.internal`, `3310` — or `MALWARE_SCAN_DISABLED=true` (structural checks only)     |
| `TRUST_PROXY`                                                          | `1` (Railway's proxy appends the client to `X-Forwarded-For`; use `2` with another proxy in front) |
| `CONVERTER_URL`, `CONVERTER_TOKEN` (optional)                          | `http://<converter>.railway.internal:8080` and the converter's token — set both or neither         |

**Email (optional, off until a provider is configured).** The mailer supports Cloudflare Email Sending and Resend.
The app queues private download links, expiry reminders and download digests through the same worker. Without
provider configuration, it creates personal links for manual sharing and does not send email.

For **Cloudflare Email Sending**:

1. In Cloudflare, open **Compute → Email Service → Email Sending → Onboard Domain** and onboard the sending domain.
   Wait for its DNS checks to pass. General-recipient sending requires Workers Paid; Email Routing alone is insufficient.
2. Create an API token with **Email Sending: Edit**, scoped to the account owning that domain. Use a scoped API token,
   not the global API key or R2 storage credentials.
3. After the app version supporting Cloudflare is deployed, add all four variables together on the **main app service**:
   ```env
   MAIL_PROVIDER=cloudflare
   CLOUDFLARE_ACCOUNT_ID=your_32_character_account_id
   CLOUDFLARE_EMAIL_API_TOKEN=your_private_scoped_api_token
   MAIL_FROM=Rokela PDF <transfers@rokelapdf.com>
   ```
   `MAIL_FROM` must use a domain onboarded for Email Sending. Substitute your actual verified domain and account.
   Keep the token in Railway secrets, never in source control or chat. Deploy after saving the complete configuration.
4. Submit a transfer from a verified sender account to an address you control and check Cloudflare's email activity.
   Existing links that were created for manual sharing are not retroactively emailed; use the transfer's resend action
   or submit a new transfer. Confirm receipt before opening sending to customers.

Cloudflare is called through its HTTPS REST API, so the app stays on Railway and needs no additional Worker.
The adapter checks Cloudflare's recipient result, including bounces and suppressions, rather than HTTP status alone.
Cloudflare does not document provider idempotency for this endpoint; if acceptance succeeds but the response is lost,
worker retries may produce duplicate messages. `X-Rokela-Job-ID` correlates attempts; it is not a deduplication guarantee.

For **Resend**, verify a sending domain, create a sending-only API key, and set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`
and `MAIL_FROM` together. Existing installations with only `RESEND_API_KEY` and `MAIL_FROM` continue to work.
If credentials for both providers are present, explicitly select `MAIL_PROVIDER`. Incomplete configuration fails at startup.

References: [Cloudflare domain onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/),
[REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).

The app refuses to start in production if any of these is missing or weak (e.g. local storage, short secret,
non-HTTPS origins, no ClamAV without the explicit opt-out).

### Startup error: `CONVERTER_URL must be an origin`

This means configuration validation failed before the app finished starting. Set `CONVERTER_URL` on the
**app service** to `http://<actual-converter-service-name>.railway.internal:8080`. Replace the placeholder with
its real private hostname. Use the converter's actual listening port if you changed it. Do not append `/health`,
`/v1/convert`, a query string, or credentials. Public converter origins must use HTTPS.

A bare Railway private hostname (including a resolved `RAILWAY_PRIVATE_DOMAIN` reference) is also accepted;
the app adds `http://` and port `8080` unless a port is supplied. Full URLs keep their explicit/default URL port.
Unresolved Railway references and placeholder text are invalid. Keep `CONVERTER_TOKEN` identical on both services
and at least 32 characters long. Redeploy the app after correcting the variables. If Office conversion is not
being used, remove **both** converter variables.

The npm warning `config production Use --omit=dev instead` is separate from this startup failure. If your build
settings set `NPM_CONFIG_PRODUCTION`, remove that legacy setting; use `npm ci --omit=dev` only for a separate
runtime install (the build needs dev dependencies).

## 4. First operator and plans

Each workspace has **one unified Rokela plan** covering PDF tools, file transfers
and link shortening. `org_plans.org_id` is the primary key, so updating a plan
replaces that workspace's plan rather than adding a product subscription. Entitlement
keys control capabilities and limits within this bundle, not separate subscriptions.
Plans remain operator-managed; no payment provider or automatic charges are enabled.
Browser PDF tools stay free, while server conversions retain sign-in and safety limits.
A team workspace's plan covers its members; another workspace has its own plan.

1. Sign up in the app with your own email and confirm it.
2. From your machine (or a Railway one-off shell) with `DATABASE_MIGRATE_URL` and `DATABASE_CA_PEM` set:
   ```bash
   npm run bootstrap:operator -- --email you@example.com --reason "initial operator"
   ```
3. Give a workspace paid features (audited, requires an operator):
   ```bash
   npm run plan:set -- --org <workspace id> --plan business --by you@example.com --reason "first customer" \
     --entitlements '{"share_persistent":true,"share_upload_requests":true,"share_storage_bytes":107374182400}'
   ```
   Keys: `share_storage_bytes`, `share_max_file_bytes`, `share_retention_days`, `share_persistent`,
   `share_bandwidth_bytes_per_month`, `share_api_requests_per_month`, `share_processing_bytes_per_month`,
   `share_upload_requests`, `share_custom_domains`, `share_branding`, `share_advanced_analytics`.

## 5. First-deploy checklist

- [ ] `https://<domain>/api/v1/health` returns `{"ok":true}`.
- [ ] Response headers on `/` include a `content-security-policy` with a nonce, and `strict-transport-security`.
- [ ] Sign up → confirmation email arrives → sign in → personal workspace appears.
- [ ] Editor: open a PDF, add text, _Save to workspace_ (an upload to R2 — if it fails, check the R2 CORS origin).
- [ ] The document page shows the draft checked within seconds (if not: ClamAV reachable? `CLAMD_HOST`).
- [ ] Export, publish, create a share link, open it in a private window, download.
- [ ] Revoke the link → the private window shows “revoked”.
- [ ] If the converter is deployed: signed in, _PDF to Word_ and _Word to PDF_ each return a file; signed out, the
      tool asks you to log in.
- [ ] Supabase → Table editor shows no `rokela` tables under the API; Settings → API exposed schemas = `public` only.

## Local development

```bash
npm install
npm test                 # throwaway PostgreSQL (needs PostgreSQL 15–17 binaries) or DATABASE_URL
DATABASE_URL=postgres://… npm run migrate && npm run dev
```

Without `SUPABASE_URL`, development expects a local Supabase (`supabase start`, http://127.0.0.1:54321). Files are
stored on disk and served by a separate local content origin on port 3001.

## Signup confirmation delivery is configured in Supabase

Cloudflare `MAIL_PROVIDER` settings above send application transfer/reminder/digest
mail. Signup confirmations, recovery and email changes are sent by Supabase Auth.
Configuring a Cloudflare app sender/template does not change Supabase's sender or
confirmation template. A message from `noreply@mail.app.supabase.io` with the default
confirmation text indicates that default path was used for that message.

For public trials, configure Supabase Authentication's custom SMTP settings with a
verified sender, host, port and SMTP credentials. An HTTP API token is not an SMTP
password. Alternatively, retaining a REST-only provider requires a properly signed
Supabase Send Email Hook bridge. The opt-in Cloudflare bridge is implemented at
`/api/auth/send-email`; follow [activation and rollback](auth-email-hook.md). Do not
point the hook at the file-sharing API or disable email confirmation to bypass it.

For SMTP delivery, edit the signup-confirmation template under Supabase Authentication → Email
Templates, preserving `{{ .ConfirmationURL }}`. The Cloudflare hook instead renders
its branded templates in application code. Configure the Site URL and allowed
redirect URLs for the actual deployed domain. Existing app sessions and Cloudflare
file-sharing delivery do not need replacing to configure this separate email path.

For an intermittent signup limit, inspect Supabase Auth logs around the exact
attempt and distinguish `over_email_send_rate_limit`, `over_request_rate_limit`,
`email_address_not_authorized` and link-expiry errors. The default sender has
project-wide limits and recipient restrictions; a later successful attempt does
not establish that public-user delivery is configured. The UI now gives separate,
safe guidance for these codes and does not promise a specific retry time.

Verify with controlled addresses after configuration: actual sender/branding,
confirmation-link completion, reset delivery and resend behavior. Avoid repeatedly
creating accounts to test limits while trial users are registering. No live sender
or Supabase project setting has been changed by this documentation/UI correction.

References: [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp),
[Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits),
[email templates](https://supabase.com/docs/guides/auth/auth-email-templates),
[Send Email Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook).
