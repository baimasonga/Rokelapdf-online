import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, expect } from 'vitest';
import { loadConfig } from '@/lib/server/config';
import { createContainer, type Container } from '@/lib/server/container';
import { buildRouter } from '@/lib/server/api/routes';
import { applyGrants, applyMigrations, MIGRATIONS_DIR } from '@/lib/server/db/schema';
import type { TokenVerifier } from '@/lib/server/auth';
import type { UserPrincipal } from '@/lib/server/kernel';
import { LocalObjectStore, createContentServer } from '@/lib/server/storage/local';
import type { FileScanner } from '@/lib/server/sharing';
import type { Mailer, OutgoingMail } from '@/lib/server/mail';
import type { ConversionLimits, Converter } from '@/lib/server/convert';

/** Records emails instead of sending them. */
export class FakeMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  async send(m: OutgoingMail) {
    this.sent.push(m);
  }
}

export const DAY = 86_400_000;
export const APP_ROLE = 'rokela_test_app';
const ORIGIN = 'http://127.0.0.1:3000';
const appRoleMode = () => process.env['ROKELA_TEST_APP_ROLE'] === '1';

function dbUrl(): string {
  const u = process.env['DATABASE_URL'];
  if (!u) throw new Error('DATABASE_URL is required (run tests through `npm test`, which starts PostgreSQL)');
  return u;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
});

/** A fresh schema, migrated by the owner; the app connects as the least-privilege role when ROKELA_TEST_APP_ROLE=1. */
async function schemaPool() {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: dbUrl() });
  await admin.connect();
  await applyMigrations(admin, MIGRATIONS_DIR, schema);
  let url = dbUrl();
  if (appRoleMode()) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (!exists.rowCount) await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'test-only-password'`).catch(() => undefined);
    await applyGrants(admin, schema, APP_ROLE);
    const u = new URL(url);
    u.username = APP_ROLE;
    u.password = 'test-only-password';
    url = u.toString();
  }
  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${schema}` });
  const adminPool = new pg.Pool({ connectionString: dbUrl(), max: 2, options: `-c search_path=${schema}` });
  cleanups.push(async () => {
    await pool.end();
    await adminPool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return { pool, adminPool };
}

/** Maps test tokens to users, standing in for Supabase Auth. */
export class FakeVerifier implements TokenVerifier {
  readonly users = new Map<string, UserPrincipal>();
  async verify(token: string) {
    return this.users.get(token);
  }
}

export interface TestEnv {
  c: Container;
  clock: { now: () => Date; advance: (ms: number) => void };
  verifier: FakeVerifier;
  admin: pg.Pool;
  call(
    method: string,
    path: string,
    o?: { token?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are loosely typed JSON
  ): Promise<{ status: number; body: any; headers: Headers; text: string }>;
  /** Signs a user in (creates them on first use). */
  user(email: string, o?: { verified?: boolean }): Promise<{ token: string; userId: string; orgId: string }>;
  operator(email: string): Promise<string>;
  plan(orgId: string, entitlements: Record<string, number | boolean>): Promise<void>;
  /** Committed audit events of an organization, oldest first. */
  audit(
    orgId: string,
    action?: string,
  ): Promise<Array<{ action: string; reason: string | null; actor: { type: string; id: string | null }; metadata: Record<string, unknown> }>>;
  content(
    method: 'PUT' | 'GET' | 'OPTIONS',
    url: string,
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Buffer; headers: Headers }>;
  close(): Promise<void>;
}

export async function makeEnv(
  o: {
    scanner?: FileScanner;
    resolveTxt?: (n: string) => Promise<string[][]>;
    env?: Record<string, string>;
    mailer?: Mailer;
    converter?: Converter;
    conversionLimits?: Partial<ConversionLimits>;
  } = {},
): Promise<TestEnv> {
  let t = new Date('2026-03-01T00:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
  const { pool, adminPool } = await schemaPool();
  const config = loadConfig({
    APP_ENV: 'test',
    TRIAL_MODE: 'false',
    DATABASE_URL: dbUrl(),
    PUBLIC_ORIGIN: ORIGIN,
    RATE_LIMIT_PER_MINUTE: '100000',
    ...o.env,
  } as unknown as NodeJS.ProcessEnv);
  const verifier = new FakeVerifier();
  // Real content server on an ephemeral port; signed URLs name the configured origin and are rewritten to it.
  const store = new LocalObjectStore({
    root: mkdtempSync(join(tmpdir(), 'rokela-test-')),
    signingSecret: config.sharingSecret,
    contentOrigin: 'http://127.0.0.1:3001',
    minPartBytes: 1,
  });
  const server = createContentServer(store, { allowedOrigin: ORIGIN, now: () => clock.now().getTime() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const c = createContainer(config, {
    pool,
    clock,
    verifier,
    objects: store,
    ...(o.scanner ? { scanner: o.scanner } : {}),
    ...(o.resolveTxt ? { resolveTxt: o.resolveTxt } : {}),
    ...(o.mailer ? { mailer: o.mailer } : {}),
    ...(o.converter ? { converter: o.converter } : {}),
    ...(o.conversionLimits ? { conversionLimits: o.conversionLimits } : {}),
    sharing: { partBytes: 8 },
  });
  (c as { localStore: LocalObjectStore | undefined }).localStore = store;
  const router = buildRouter();
  const env: TestEnv = {
    c,
    clock,
    verifier,
    admin: adminPool,
    async call(method, path, opt = {}) {
      const res = await router.handle(
        c,
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            ...(opt.token ? { authorization: `Bearer ${opt.token}` } : {}),
            ...(opt.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opt.headers,
          },
          ...(opt.body !== undefined ? { body: JSON.stringify(opt.body) } : {}),
          ...(opt.raw !== undefined ? { body: opt.raw as BodyInit } : {}),
        }),
      );
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        /* not JSON */
      }
      return { status: res.status, body, headers: res.headers, text };
    },
    async user(email, uo = {}) {
      const token = `test-token-${randomBytes(24).toString('hex')}`;
      const existing = [...verifier.users.values()].find((u) => u.email === email);
      verifier.users.set(token, { userId: existing?.userId ?? crypto.randomUUID(), email, emailVerified: uo.verified ?? existing?.emailVerified ?? false });
      const me = await env.call('GET', '/api/v1/me', { token });
      expect(me.status).toBe(200);
      return { token, userId: me.body.user.id, orgId: me.body.workspaces.find((w: { kind: string }) => w.kind === 'personal').id };
    },
    async operator(email) {
      const u = await env.user(email, { verified: true });
      await adminPool.query('UPDATE users SET is_operator = true WHERE id = $1', [u.userId]);
      return u.token;
    },
    async plan(orgId, entitlements) {
      const owner = (await adminPool.query("SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'owner' LIMIT 1", [orgId])).rows[0].user_id;
      await adminPool.query(
        `INSERT INTO org_plans (org_id, plan, entitlements, updated_at, updated_by, reason) VALUES ($1,'business',$2,now(),$3,'test plan')
         ON CONFLICT (org_id) DO UPDATE SET entitlements = EXCLUDED.entitlements`,
        [orgId, JSON.stringify(entitlements), owner],
      );
    },
    async audit(orgId, action) {
      const r = await adminPool.query(
        `SELECT action, reason, actor_type, actor_id, metadata FROM audit_events WHERE org_id = $1 ${action ? 'AND action = $2' : ''} ORDER BY seq`,
        action ? [orgId, action] : [orgId],
      );
      return r.rows.map((x) => ({ action: x.action, reason: x.reason, actor: { type: x.actor_type, id: x.actor_id }, metadata: x.metadata }));
    },
    async content(method, url, body, headers) {
      const u = new URL(url);
      const res = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
  return env;
}

/** Invites `email` to a team and accepts as `invitee` (a signed-in user with that address confirmed). */
export async function joinTeam(env: TestEnv, ownerToken: string, orgId: string, invitee: { token: string }, email: string, role = 'member') {
  const inv = await env.call('POST', `/api/v1/workspaces/${orgId}/members`, { token: ownerToken, body: { email, role } });
  expect(inv.status).toBe(201);
  const ok = await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: invitee.token, body: {} });
  expect(ok.status).toBe(200);
}
