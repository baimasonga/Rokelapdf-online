# Warrior monitoring adapter

This server-only adapter preserves Supabase authentication and the one workspace
subscription covering PDF, transfers and short links. It has no licensing,
billing, document, token-retrieval or remediation authority.

Configuration is opt-in: `WARRIOR_EVENTS_TOKEN`, `WARRIOR_API_COMPONENT_ID`,
`WARRIOR_CONVERTER_COMPONENT_ID`, `WARRIOR_SCANNER_COMPONENT_ID`. All must be
provided together. The transport destination is fixed to Warrior's production
HTTPS origin; there is no browser configuration, caller URL or redirect following.
Use a separate `events:write` credential for each registered source environment,
issued by an authorized owner/admin through fresh MFA. Never place it in chat,
source, public variables, arguments, logs or a browser build.

Only conversion failure, scanner unavailability, asserted malware verdict and
component heartbeat envelopes are admitted. Names, documents, email addresses,
URLs, object keys, request IDs, exceptions and arbitrary attributes are excluded.
Heartbeats reflect real checks/work, not a constant claim that every dependency is
healthy. Unexercised dependencies remain unknown. Upload access remains fail closed
on scanner failure even if monitoring is unavailable.

A private-schema PostgreSQL outbox persists UUID event identity and exact payload
before transport. It is bounded to 1,000 records, 50 per batch and 23-hour retries
(collector rejects new observations older than 24 hours). A fixed dropped counter
makes queue saturation visible. Claims are fenced and expire; retries preserve
payload identity across process restart. ACKs must cover every submitted ID with a
stored/duplicate disposition. Ambiguous outcomes are retried unchanged. No exactly
once promise is made. Retry delay caps at 300 seconds; expired/rejected rows remain
visible until bounded retention. No response body/error payload is logged.

Capture uses a separate two-connection pool with one-second connection/query
budgets and short lock timeout. Failures return false and cannot replace business
results. The worker sends outside transactions with a five-second transport timeout,
no redirects and a bounded response body. Queue status exposes counts and times,
never payloads or credentials. Rollback: unset the four WARRIOR variables and
redeploy; the adapter becomes inert without changing authentication or access.

Local fake-collector/PG tests and rollout observations are recorded with implementation
results. Deployment credentials and a live source failure/recovery acceptance are
required before describing production monitoring as connected.

## Verification

With an isolated PostgreSQL database, `npm run check` exercises the source queue.
`ROKELA_TEST_APP_ROLE=1 npm test` repeats the source tests with least-privilege grants.
For the cross-repository acceptance, supply a local Warrior checkout explicitly:

```sh
WARRIOR_CHECKOUT=/path/to/security-system DATABASE_URL=postgres://local-test-db \
  npx vitest run tests/integration/warrior-local.test.ts
```

That test provisions a synthetic owner, enrolls MFA, issues a scoped credential,
creates a rule and drives a real source conversion failure through two private test
schemas. The collector transport is injected and never contacts production. It
proves restart retry, exact ID retention, durable receipt, concurrent deduplication,
fresh recovery, portal notification intents and audit verification. Without
`WARRIOR_CHECKOUT`, this optional cross-repository test is explicitly skipped; a
skipped test is not integration acceptance.

## Idle dependency readiness (24 October 2026)

With monitoring configured, a separate background task runs at startup and every
60 seconds. Runs never overlap and do not wait for sharing jobs or maintenance.
The converter check calls only the configured converter's `/health`, refuses
redirects, requires HTTP success plus `ok: true` and `service: rokela-converter`,
and caps the body at 4 KiB and the whole request at five seconds. No converter
credential or document is sent. This checks installed converter dependencies,
not authentication or the correctness of every conversion format.

The scanner check sends ClamAV's `zPING` command to the configured private daemon,
requires an exact `PONG` response, and caps the reply at 64 characters and the
whole connection at five seconds. It checks daemon responsiveness, not a real
file scan or signature freshness. A missing converter/ClamAV configuration reports
unknown rather than claiming health from structural-only content checks. A failed
scanner probe also emits `scanner.unavailable` with bounded actual queue counts.
Converter probe failures emit unavailable heartbeats, never fabricated conversion
failures. Fresh successful probes provide recovery evidence to Warrior.

Checks run independently; monitoring errors cannot prevent document jobs or
startup. Probe errors, addresses, responses and credentials are never logged or
included in monitoring payloads. Existing upload scans remain fail closed.

Railway's tracked `railway.json` configures `/api/v1/health` with a 120-second
healthcheck timeout. Live dashboard overrides must be inspected separately; source
configuration alone is not proof of a successful deployed health check. An
independent external uptime monitor and its alert destination remain separate
account configuration, not provided by these dependency probes.

Verification and rollout: readiness/protocol tests exercise failures, recovery,
wrong service/body, response budgets, a silent scanner, HTTP body timeout,
startup cadence, non-overlap and disabled monitoring. Confirm fresh idle reports
from all three actual production components after GitHub deployment before
claiming this release live. Never stop production dependencies to test alerts;
use isolated fake services for failure/recovery acceptance.

Local evidence for this change (24 October 2026): `npm run check` passed
(268 passed, two optional tests skipped), production build passed, and focused
Warrior suites passed as the restricted app role (22 tests). The optional
cross-repository acceptance was run separately with the Warrior checkout and
passed conversion failure → durable receipt → deduplicated incident → fresh
recovery. Deliberate wrong-service acceptance and slow-schedule mutations were
caught by the focused tests and restored. These are isolated tests, not a claim
that the new readiness task is already running in production.
