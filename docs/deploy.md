# Deploying: Supabase + Cloudflare R2 + Railway

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

1. _New project → Deploy from GitHub repo_ → this repository. [`railway.json`](../railway.json) is picked up:
   build `npm run build`, **pre-deploy `npm run deploy:prepare`** (migrations + grants; a failure stops the deploy and
   the previous version keeps serving), start `npm start`, health check `/api/v1/health`.
2. Optional malware scanning: _New → GitHub repo_ (same repo) → service Settings → _Config file path_
   `infra/clamav/railway.json`. ~2 GB memory, **no public domain**. Its private host is `<name>.railway.internal`.
3. App service → Settings → _Networking_: add your custom domain (Railway issues the certificate).

### App variables (mark secrets as secret)

| Variable                                                               | Value                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                             | `production`                                                                                   |
| `PUBLIC_ORIGIN`                                                        | `https://<your app domain>`                                                                    |
| `SHORT_ORIGIN` (optional)                                              | a separate short domain for public short links, e.g. `https://rkl.to`                          |
| `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `DATABASE_CA_PEM`              | from §1                                                                                        |
| `APP_DB_ROLE`                                                          | `rokela_app`                                                                                   |
| `DB_SCHEMA` (optional)                                                 | `rokela` (default)                                                                             |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                             | from §1                                                                                        |
| `SHARING_SECRET`                                                       | `openssl rand -base64 48` — signs link tokens; changing it invalidates every link              |
| `STORAGE`                                                              | `r2`                                                                                           |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from §2                                                                                        |
| `CLAMD_HOST`, `CLAMD_PORT`                                             | `<clamav>.railway.internal`, `3310` — or `MALWARE_SCAN_DISABLED=true` (structural checks only) |
| `TRUST_PROXY`                                                          | `1` (Railway's proxy sets `X-Forwarded-For`)                                                   |

The app refuses to start in production if any of these is missing or weak (e.g. local storage, short secret,
non-HTTPS origins, no ClamAV without the explicit opt-out).

## 4. First operator and plans

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
- [ ] Supabase → Table editor shows no `rokela` tables under the API; Settings → API exposed schemas = `public` only.

## Local development

```bash
npm install
npm test                 # throwaway PostgreSQL (needs PostgreSQL 15–17 binaries) or DATABASE_URL
DATABASE_URL=postgres://… npm run migrate && npm run dev
```

Without `SUPABASE_URL`, development expects a local Supabase (`supabase start`, http://127.0.0.1:54321). Files are
stored on disk and served by a separate local content origin on port 3001.
