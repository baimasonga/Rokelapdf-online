# Independent Cloudflare backup host (staging preparation)

This deployment runs the existing Node/Next.js application in Cloudflare Containers.
Requests go from a Cloudflare Worker to a container built from this repository;
they are **not forwarded to Railway**. Supabase Auth/Postgres and private R2 storage
remain shared. This provides an independent app release path when Railway builds
are delayed. It does not provide redundancy for Supabase or R2 outages.

The preparation uses Containers rather than a Workers-native Next.js migration.
The app runs timers, PostgreSQL connections, TCP malware scanning and Node crypto.
At preparation time, OpenNext `1.20.12` also excludes this pinned Next `16.3.8` from
its supported peer range. A static Pages upload would lose the server features.

## What is prepared

- `Dockerfile.cloudflare`: Linux amd64, Node 22, non-root runtime, standalone Next
  output with browser PDF/OCR assets. `ROKELA_STANDALONE=1` only changes the backup
  build; the existing Railway build stays the same.
- `infra/cloudflare/wrangler.jsonc`: a separate staging Worker, one container,
  SQLite Durable Object binding and a one-minute health-check Cron Trigger.
- A fixed container instance runs the same durable database job queue. Claims are
  fenced in PostgreSQL, so the existing Railway instance can remain active.
- Only named app settings enter the container. The Cloudflare deployment token is
  never copied into the image or container. `MAIL_API_TOKEN` maps to the app's email
  token separately from Wrangler credentials.
- Staging requests use the canonical production Host header. Responses are not
  cached at the edge. Authentication and signed URLs must remain private.

`ENABLE_BACKUP=false` is intentional: publishing this configuration does not
activate app traffic, start the app through the health cron, change DNS or enable
automatic failover. Once enabled and first started, idle shutdown is suppressed
and cron health requests help restart it after failures. Cloudflare can still
restart/evict containers. A warm backup incurs container runtime charges.

## Prerequisites before activation

Use a Cloudflare account with Workers Paid and Containers enabled, and authenticate
Wrangler using that account. Configure the existing app values through Worker
secret settings; do not put values in Git, Docker build arguments or chat:

| Setting                                                                 | Requirement                                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                          | Existing least-privilege app connection, reachable from Cloudflare; use the correct Supabase pooler/region and verify TLS.                                     |
| `DATABASE_CA_PEM`                                                       | Existing verified CA if the database requires it.                                                                                                              |
| `SUPABASE_PUBLISHABLE_KEY`                                              | Same Supabase project as the primary.                                                                                                                          |
| `SHARING_SECRET`                                                        | Exactly the same signing secret as the primary, so existing links remain valid.                                                                                |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`  | Existing private bucket and credentials, with CORS for the canonical origin.                                                                                   |
| `CLAMD_HOST`, optional `CLAMD_PORT`                                     | An independent, reachable scanner. A Railway private hostname is not reachable here. No antivirus opt-out is configured by this backup.                        |
| `CONVERTER_URL`, `CONVERTER_TOKEN`                                      | Required for Office feature parity. Use an authenticated HTTPS converter outside Railway for full independence. A `*.railway.internal` endpoint will not work. |
| `MAIL_PROVIDER`, `MAIL_FROM`, `CLOUDFLARE_ACCOUNT_ID`, `MAIL_API_TOKEN` | Existing verified Cloudflare email provider settings if mail is enabled.                                                                                       |
| `AUTH_EMAIL_HOOK_SECRET`                                                | Same Supabase signing secret if the email hook is enabled.                                                                                                     |

Do not declare full failover readiness while scanning is unavailable or Office
conversion still depends on Railway. Independent scanner/converter provisioning
is a separate service deployment; this app image contains neither engine.

Keep `PUBLIC_ORIGIN` and `SHORT_ORIGIN` set to `https://www.rokelapdf.com` for an
eventual same-domain failover. Keep the same Supabase Site URL, redirect allowlist,
R2 CORS and email-hook URL. A preview hostname is not an alternate PKCE origin;
absolute links can lead back to the currently active production host. Full login
and recovery validation needs a controlled same-domain routing test, not only a
workers.dev homepage check.

## Build and stage without changing production

From the repository root:

```sh
npm ci
ROKELA_STANDALONE=1 npm run build
docker build --platform linux/amd64 -f Dockerfile.cloudflare -t rokela-backup:local .
cd infra/cloudflare
npm ci
npm run check
npm run build
```

`npm run build` in `infra/cloudflare` performs a Wrangler dry run and builds the
image; it does not publish. After local validation, an authenticated operator can
run `npm run deploy:staging`. It uploads a Worker/container deployment and requires
Cloudflare account permissions. Provisioning can take several minutes. Check
`npx wrangler containers list` and container logs before treating it as available.

The **Cloudflare backup staging** GitHub workflow provides an independent
release path after these files are committed and pushed. Set the repository
secret `CLOUDFLARE_BACKUP_DEPLOY_TOKEN` and variable `CLOUDFLARE_BACKUP_ACCOUNT_ID`,
then run the workflow on the reviewed commit. It also runs automatically when
Cloudflare deployment files change on the release branch. It deploys an **inactive** backup,
without waiting for a Railway build. The token needs the Cloudflare permissions
required for Workers, Durable Objects, Containers and container image publishing;
an email-only token is insufficient. Runtime app secrets are configured separately
on the Worker and are not passed through the GitHub build.

Enter the required secrets in Worker settings (or through `wrangler secret put`),
and leave `ENABLE_BACKUP=false` until they and independent services are complete.
Then set it to `true`, redeploy, and request `/api/v1/health` on the staging Worker.
Check both app readiness and the database, not merely whether the Worker responds.

Run migrations and grants **once**, through the existing controlled release step
(`npm run deploy:prepare` with the administrative connection in a secure shell).
Never give the backup the migration-owner connection or run migrations at every
container start. Only backward-compatible schema changes may be released while
primary and backup versions coexist. Pin the same approved Git commit on both.

## Verify and switch

1. Verify database access, R2 upload/download, queued quarantine processing and
   antivirus rejection on Cloudflare. Run `npm run check:services` using the same
   backup settings from a secure test environment, including real Office conversion.
2. Check same-domain login, signup confirmation, password recovery, sharing,
   email delivery and existing signed links in a controlled routing window.
3. Configure external health monitoring against the backup readiness endpoint.
   For automatic failover, configure Cloudflare Load Balancing or a separately
   reviewed routing controller; this staging Worker does not implement it.
4. For initial manual failover, attach the canonical app domain to the Cloudflare
   Worker only after validation and record the current DNS/Worker route first.
   Do not put a live Worker route on top of an unrelated Worker/custom domain.
5. Roll back by restoring the recorded primary routing. Leave Supabase, R2,
   signing secrets and authentication URLs unchanged; do not roll back migrations
   destructively. Review pending jobs and provider activity after the switch.

No account, domain, paid resource or live traffic is created by committing these
files. Deployment credentials and independent scanner/converter readiness are
required before this can be called a working production backup.

References: [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/),
[Container SDK](https://github.com/cloudflare/containers),
[Cloudflare Load Balancing](https://developers.cloudflare.com/load-balancing/).
