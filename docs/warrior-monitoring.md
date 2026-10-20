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
