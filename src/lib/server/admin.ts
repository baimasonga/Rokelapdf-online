import type { Queryable } from './db/pg';
import { DomainError, systemClock, type AuditEventInput } from './kernel';
import { appendAuditInTx } from './db/audit';
import { LIMIT_ENTITLEMENTS } from './sharing/policy';

// Deployment tooling that runs with the schema-owner connection (never from the web app). Every mutation
// requires a reason and commits together with its audit event.

async function tx<T>(client: Queryable, fn: (audit: AuditEventInput[]) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const audit: AuditEventInput[] = [];
    const out = await fn(audit);
    await appendAuditInTx(client, systemClock, audit);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

function needReason(reason: string | undefined): string {
  const r = reason?.trim() ?? '';
  if (r.length < 3 || r.length > 500) throw new DomainError('invalid_request', 'a reason (3-500 characters) is required');
  return r;
}

async function userByEmail(client: Queryable, email: string): Promise<{ id: string; is_operator: boolean }> {
  const r = await client.query('SELECT id, is_operator FROM users WHERE email = lower($1) FOR UPDATE', [email.trim()]);
  if (!r.rows[0]) throw new DomainError('not_found', 'no such user (they must sign in once first)');
  return r.rows[0] as { id: string; is_operator: boolean };
}

/** Promotes an existing user to platform operator. The only way to create the first operator. */
export async function bootstrapOperator(client: Queryable, o: { email: string; reason: string | undefined }) {
  const reason = needReason(o.reason);
  return tx(client, async (audit) => {
    const u = await userByEmail(client, o.email);
    if (u.is_operator) return { userId: u.id, changed: false };
    await client.query('UPDATE users SET is_operator = true, updated_at = now() WHERE id = $1', [u.id]);
    audit.push({ actor: { type: 'system', id: 'bootstrap-operator' }, action: 'operator.granted', target: { type: 'user', id: u.id }, reason });
    return { userId: u.id, changed: true };
  });
}

const BOOLEAN_KEYS = new Set<string>([
  LIMIT_ENTITLEMENTS.persistent,
  LIMIT_ENTITLEMENTS.uploadRequests,
  LIMIT_ENTITLEMENTS.customDomains,
  LIMIT_ENTITLEMENTS.branding,
  LIMIT_ENTITLEMENTS.advancedAnalytics,
  LIMIT_ENTITLEMENTS.verifiedDocuments,
]);
const KNOWN_KEYS = new Set<string>(Object.values(LIMIT_ENTITLEMENTS));

/** Rejects unknown keys and mistyped values so a typo cannot silently grant nothing (or too much). */
export function validateEntitlements(raw: unknown): Record<string, number | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError('invalid_request', 'entitlements must be an object');
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k)) throw new DomainError('invalid_request', `unknown entitlement: ${k}`);
    if (BOOLEAN_KEYS.has(k) ? typeof v !== 'boolean' : !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
      throw new DomainError('invalid_request', `invalid value for entitlement: ${k}`);
    out[k] = v as number | boolean;
  }
  return out;
}

/** Sets an organization's plan. `byEmail` must be an operator; the change is attributed to them. */
export async function setPlan(client: Queryable, o: { orgId: string; plan: string; entitlements: unknown; byEmail: string; reason: string | undefined }) {
  const reason = needReason(o.reason);
  const ents = validateEntitlements(o.entitlements);
  const plan = o.plan.trim();
  if (plan.length < 1 || plan.length > 60) throw new DomainError('invalid_request', 'invalid plan name');
  return tx(client, async (audit) => {
    const by = await userByEmail(client, o.byEmail);
    if (!by.is_operator) throw new DomainError('forbidden', 'only operators can change plans');
    const org = await client.query('SELECT id FROM organizations WHERE id = $1', [o.orgId]);
    if (!org.rowCount) throw new DomainError('not_found', 'no such workspace');
    const prev = await client.query('SELECT plan, entitlements FROM org_plans WHERE org_id = $1 FOR UPDATE', [o.orgId]);
    await client.query(
      `INSERT INTO org_plans (org_id, plan, entitlements, updated_at, updated_by, reason) VALUES ($1,$2,$3,now(),$4,$5)
       ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan, entitlements = EXCLUDED.entitlements,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason`,
      [o.orgId, plan, JSON.stringify(ents), by.id, reason],
    );
    audit.push({
      actor: { type: 'operator', id: by.id },
      action: 'org.plan.changed',
      target: { type: 'org', id: o.orgId },
      orgId: o.orgId,
      reason,
      metadata: { plan, entitlements: ents, previous: prev.rows[0] ?? null },
    });
    return { orgId: o.orgId, plan, entitlements: ents };
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEAR_MS = 365 * 86_400_000;

function licenseEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254 || !EMAIL.test(e)) throw new DomainError('invalid_request', 'a valid email is required');
  return e;
}

async function operator(client: Queryable, byEmail: string): Promise<string> {
  const by = await userByEmail(client, byEmail);
  if (!by.is_operator) throw new DomainError('forbidden', 'only operators can change licences');
  return by.id;
}

/**
 * Grants or renews a person's licence for the paid tools (src/lib/licensing.ts), tied to their email. The person need
 * not have signed in yet. Renewing adds the years to the end of a licence that is still running, so paying early
 * loses nothing; otherwise the licence starts now.
 */
export async function grantLicense(client: Queryable, o: { email: string; years?: number; byEmail: string; reason: string | undefined; now?: Date }) {
  const reason = needReason(o.reason);
  const email = licenseEmail(o.email);
  const years = o.years ?? 1;
  if (!Number.isInteger(years) || years < 1 || years > 5) throw new DomainError('invalid_request', 'years must be 1 to 5');
  return tx(client, async (audit) => {
    const by = await operator(client, o.byEmail);
    const now = o.now ?? new Date();
    const prev = (await client.query('SELECT valid_from, valid_until FROM user_licenses WHERE email = $1 FOR UPDATE', [email])).rows[0] as
      { valid_from: Date; valid_until: Date } | undefined;
    const running = prev && prev.valid_until > now;
    const from = running ? prev.valid_from : now;
    const until = new Date((running ? prev.valid_until : now).getTime() + years * YEAR_MS);
    await client.query(
      `INSERT INTO user_licenses (email, valid_from, valid_until, updated_at, updated_by, reason) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason`,
      [email, from, until, now, by, reason],
    );
    audit.push({
      actor: { type: 'operator', id: by },
      action: 'license.granted',
      target: { type: 'license', id: email },
      reason,
      metadata: { years, validFrom: from.toISOString(), validUntil: until.toISOString(), previousUntil: prev?.valid_until.toISOString() ?? null },
    });
    return { email, validFrom: from, validUntil: until };
  });
}

/** Ends a licence now (a refund or a mistake). The record stays, so the history is kept. */
export async function revokeLicense(client: Queryable, o: { email: string; byEmail: string; reason: string | undefined; now?: Date }) {
  const reason = needReason(o.reason);
  const email = licenseEmail(o.email);
  return tx(client, async (audit) => {
    const by = await operator(client, o.byEmail);
    const now = o.now ?? new Date();
    const prev = (await client.query('SELECT valid_from, valid_until FROM user_licenses WHERE email = $1 FOR UPDATE', [email])).rows[0] as
      { valid_from: Date; valid_until: Date } | undefined;
    if (!prev) throw new DomainError('not_found', 'no licence for that email');
    if (prev.valid_until <= now) return { email, changed: false };
    // A licence that has not started yet ends at its start (valid_until may not precede valid_from).
    const until = prev.valid_from > now ? prev.valid_from : now;
    await client.query('UPDATE user_licenses SET valid_until = $2, updated_at = $3, updated_by = $4, reason = $5 WHERE email = $1', [
      email,
      until,
      now,
      by,
      reason,
    ]);
    audit.push({
      actor: { type: 'operator', id: by },
      action: 'license.revoked',
      target: { type: 'license', id: email },
      reason,
      metadata: { previousUntil: prev.valid_until.toISOString() },
    });
    return { email, changed: true };
  });
}

/** The licence held for an email, if any (read-only). */
export async function showLicense(client: Queryable, email: string) {
  const r = await client.query('SELECT email, valid_from, valid_until, updated_at, reason FROM user_licenses WHERE email = $1', [licenseEmail(email)]);
  return r.rows[0] as { email: string; valid_from: Date; valid_until: Date; updated_at: Date; reason: string } | undefined;
}
