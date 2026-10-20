import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { makeEnv } from '../support/env';
import { createContainer as sourceContainer } from '@/lib/server/container';
import { WarriorMonitor } from '@/lib/server/warrior';
import { DomainError } from '@/lib/server/kernel';
const checkout = process.env.WARRIOR_CHECKOUT;
it.skipIf(!checkout)(
  'real conversion outage → durable receipt → one incident → fresh recovery',
  async () => {
    const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(checkout!, path)).href);
    const [{ createContainer }, { loadConfig }, { buildApp }, { applyMigrations, MIGRATIONS_DIR }, { totpCode }] = await Promise.all([
      load('services/platform-api/src/container.ts'),
      load('services/platform-api/src/config.ts'),
      load('services/platform-api/src/app.ts'),
      load('services/platform-api/src/db/migrate.ts'),
      load('packages/auth/src/mfa.ts'),
    ]);
    const schema = 'pdf_warrior_' + randomBytes(6).toString('hex');
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
    const migrate = await pool.connect();
    try {
      await applyMigrations(migrate, MIGRATIONS_DIR);
    } finally {
      migrate.release();
    }
    const env = await makeEnv();
    env.clock.advance(Date.now() - +env.clock.now());
    const target = await createContainer(
      {
        ...loadConfig({ NODE_ENV: 'test' }),
        operationsInventoryEnabled: true,
        operationsCredentialsEnabled: true,
        operationsIngestionEnabled: true,
        operationsHealthEnabled: true,
        operationsIncidentsEnabled: true,
        operationsAutomationEnabled: true,
        mfaEncryptionKey: randomBytes(32).toString('hex'),
        sharing: undefined,
      },
      { pool, clock: env.clock },
    );
    const app = await buildApp(target);
    let token: string | undefined;
    const request = async (method: string, url: string, body?: unknown, expected = 200) => {
      const r = await app.inject({
        method,
        url,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { payload: body }),
      });
      expect(r.statusCode).toBe(expected);
      return r.statusCode === 204 ? null : r.json();
    };
    try {
      const password = 'isolated-local-password-long';
      const account = await request('POST', '/v1/auth/register', { email: 'source@example.test', password }, 201);
      token = (await request('POST', '/v1/auth/login', { email: 'source@example.test', password })).token;
      const began = await request('POST', '/v1/auth/mfa/begin', { password });
      let bits = 0,
        value = 0;
      const bytes: number[] = [];
      for (const ch of began.setup_key) {
        value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          bytes.push((value >>> bits) & 255);
        }
      }
      const key = Buffer.from(bytes);
      const next = () => {
        env.clock.advance(30000);
        return totpCode(key, Math.floor(+env.clock.now() / 30000));
      };
      await request('POST', '/v1/auth/mfa/confirm', { password, code: next() });
      token = (await request('POST', '/v1/auth/login', { email: 'source@example.test', password, code: next() })).token;
      const base = `/v1/organizations/${account.personal_org.id}/operations/applications`;
      const a = await request(
        'POST',
        base,
        { code: 'rokela-pdf', owner_user_id: account.user.id, criticality: 'high', product_id: null, reason: 'initial_setup' },
        201,
      );
      const e = await request('POST', `${base}/${a.id}/environments`, { code: 'staging', kind: 'staging', reason: 'initial_setup' }, 201);
      const ep = `${base}/${a.id}/environments/${e.id}`;
      const components = [];
      for (const code of ['api', 'converter', 'scanner'])
        components.push(
          await request(
            'POST',
            ep + '/components',
            { code, kind: code === 'scanner' ? 'scanner' : 'service', dependency_ids: [], reason: 'initial_setup' },
            201,
          ),
        );
      const issued = await request(
        'POST',
        ep + '/credentials',
        { purpose: 'events:write', ttl_seconds: 86400, mfa_code: next(), reason: 'initial_setup' },
        201,
      );
      await request(
        'POST',
        ep + '/rules',
        {
          component_id: components[1].id,
          kind: 'event_count',
          event_type: 'conversion.failed',
          threshold: 1,
          window_seconds: 60,
          severity: 'warning',
          runbook: 'check_converter',
          reason: 'initial_setup',
        },
        201,
      );
      const config = { token: issued.token, apiComponentId: components[0].id, converterComponentId: components[1].id, scannerComponentId: components[2].id };
      let broken = true;
      const source = sourceContainer(
        { ...env.c.config, warrior: config },
        {
          pool: env.c.pool,
          clock: env.clock,
          converter: {
            convert: async () => {
              if (broken) throw new DomainError('unavailable', 'synthetic converter outage');
              return new TextEncoder().encode('%PDF-1.7 synthetic result');
            },
          },
        },
      );
      const convert = () =>
        source.conversions.convert({ target: 'pdf', from: 'rtf' }, 'private-customer.rtf', new TextEncoder().encode('{\\rtf synthetic private contents}'));
      await expect(convert()).rejects.toMatchObject({ code: 'unavailable' });
      const offline = new WarriorMonitor(env.c.pool, env.clock, config, async () => {
        throw new Error('synthetic collector outage');
      });
      await offline.flush();
      expect((await offline.status()).pending).toBe(2);
      const before = (await env.admin.query('SELECT id,envelope FROM warrior_outbox ORDER BY id')).rows;
      expect(JSON.stringify(before)).not.toContain('private');
      expect(JSON.stringify(before)).not.toContain(config.token);
      env.clock.advance(300000);
      const bridge: typeof fetch = async (url, init) => {
        expect(String(url)).toBe('https://trustplatform-api-production.up.railway.app/v1/operations/events');
        const r = await app.inject({
          method: 'POST',
          url: '/v1/operations/events',
          headers: init!.headers as Record<string, string>,
          payload: JSON.parse(init!.body as string),
        });
        return new Response(r.rawPayload, { status: r.statusCode, headers: { 'content-type': 'application/json' } });
      };
      const restarted = new WarriorMonitor(env.c.pool, env.clock, config, bridge);
      await restarted.flush();
      expect((await restarted.status()).pending).toBe(0);
      expect((await pool.query('SELECT id FROM operations_events ORDER BY id')).rows.map((r) => r.id)).toEqual(before.map((r) => r.id));
      const scope = { orgId: account.personal_org.id, applicationId: a.id, environmentId: e.id };
      await Promise.all(Array.from({ length: 10 }, () => target.operationsAutomation.evaluate(scope)));
      const opened = await request('GET', ep + '/incidents');
      expect(opened.items).toHaveLength(1);
      expect(opened.items[0].source).toBe('automatic_rule');
      broken = false;
      for (let i = 0; i < 3; i++) {
        env.clock.advance(61000);
        await expect(convert()).resolves.toHaveProperty('bytes');
        await restarted.flush();
        await target.operationsAutomation.evaluate(scope);
      }
      const recovered = await request('GET', ep + '/incidents');
      expect(recovered.items).toHaveLength(1);
      expect(recovered.items[0].state).toBe('resolved');
      await target.operationsAutomation.deliverPending(scope);
      expect((await request('GET', ep + '/notifications')).items).toHaveLength(2);
      expect((await target.audit.verifyChain()).ok).toBe(true);
      await source.close();
    } finally {
      await app.close();
      await target.close();
      await env.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
  90000,
);
