import { afterEach, expect, it, vi } from 'vitest';
import { WarriorMonitor } from '@/lib/server/warrior';
import { warriorConfig } from '@/lib/server/warrior-config';
import { makeEnv, type TestEnv } from '../support/env';
let env: TestEnv;
afterEach(async () => env?.close());
const config = {
  token: 'ops_v1.opc_' + 'a'.repeat(32) + '.' + 'b'.repeat(64),
  apiComponentId: 'opm_' + 'a'.repeat(24),
  converterComponentId: 'opm_' + 'b'.repeat(24),
  scannerComponentId: 'opm_' + 'c'.repeat(24),
};
const heartbeat = { type: 'component.heartbeat', attributes: { status: 'healthy' } };
it('requires complete server-only scope bindings, and never takes the site down over them', () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const full = {
    WARRIOR_EVENTS_TOKEN: config.token,
    WARRIOR_API_COMPONENT_ID: config.apiComponentId,
    WARRIOR_CONVERTER_COMPONENT_ID: config.converterComponentId,
    WARRIOR_SCANNER_COMPONENT_ID: config.scannerComponentId,
  };
  expect(warriorConfig({}, warn)).toBeUndefined();
  expect(warriorConfig(full, warn)).toEqual(config);
  // Pasted values with stray whitespace still work.
  expect(warriorConfig({ ...full, WARRIOR_SCANNER_COMPONENT_ID: ` ${config.scannerComponentId}\n` }, warn)).toEqual(config);
  expect(warnings).toEqual([]);
  // Incomplete or malformed settings disable monitoring and say which variables are wrong, never their values.
  expect(warriorConfig({ WARRIOR_EVENTS_TOKEN: config.token }, warn)).toBeUndefined();
  expect(warriorConfig({ ...full, WARRIOR_CONVERTER_COMPONENT_ID: 'opm_ABC' }, warn)).toBeUndefined();
  expect(warnings).toEqual([
    expect.stringContaining('WARRIOR_API_COMPONENT_ID, WARRIOR_CONVERTER_COMPONENT_ID, WARRIOR_SCANNER_COMPONENT_ID'),
    expect.stringMatching(/malformed WARRIOR_CONVERTER_COMPONENT_ID \(/),
  ]);
  expect(warnings.join(' ')).not.toContain(config.token);
});
it('durably retries the exact same safe event and credential destination after a collector outage and restart', async () => {
  env = await makeEnv();
  const calls: { url: string; event: Record<string, unknown> }[] = [];
  let first = true;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + config.token });
    const batch = JSON.parse(init?.body as string);
    calls.push({ url: String(input), event: batch.events[0] });
    if (first) {
      first = false;
      throw new Error('private provider body with customer document name');
    }
    return Response.json({ accepted: batch.events.map((e: { id: string }) => ({ id: e.id, disposition: 'duplicate' })) });
  });
  const monitor = new WarriorMonitor(env.c.pool, env.clock, config, transport as typeof fetch);
  expect(await monitor.capture(config.apiComponentId, heartbeat)).toBe(true);
  await monitor.flush();
  expect((await monitor.status()).pending).toBe(1);
  env.clock.advance(300000);
  const restarted = new WarriorMonitor(env.c.pool, env.clock, config, transport as typeof fetch);
  await restarted.flush();
  expect((await restarted.status()).pending).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0].url).toBe('https://trustplatform-api-production.up.railway.app/v1/operations/events');
  expect(JSON.stringify(calls)).not.toContain(config.token);
  expect(JSON.stringify(calls)).not.toContain('document');
});
it('rejects PII, arbitrary attributes, event destinations and wrong components before enqueue', async () => {
  env = await makeEnv();
  const monitor = new WarriorMonitor(env.c.pool, env.clock, config);
  for (const bad of [
    { ...heartbeat, email: 'private@example.test' },
    { type: 'component.heartbeat', attributes: { status: 'healthy', url: 'https://private.invalid' } },
    { type: 'conversion.failed', attributes: { reason: 'private filename' } },
  ])
    expect(await monitor.capture(config.apiComponentId, bad)).toBe(false);
  expect(await monitor.capture('opm_' + 'f'.repeat(24), heartbeat)).toBe(false);
  expect((await monitor.status()).pending).toBe(0);
});
it('refuses partial acknowledgements and confines queue saturation without failing business capture', async () => {
  env = await makeEnv();
  const monitor = new WarriorMonitor(env.c.pool, env.clock, config, async () => Response.json({ accepted: [] }));
  await monitor.capture(config.apiComponentId, heartbeat);
  await monitor.flush();
  expect((await monitor.status()).pending).toBe(1);
  await env.admin.query(
    `INSERT INTO warrior_outbox(id,component_id,envelope,created_at,available_at,deadline,state) SELECT (substr(md5(n::text),1,8)||'-0000-4000-8000-'||substr(md5(n::text),1,12))::uuid,$1,'{}', $2,$2,$2::timestamptz+interval '23 hours','pending' FROM generate_series(1,999) n`,
    [config.converterComponentId, env.clock.now()],
  );
  expect(await monitor.capture(config.converterComponentId, { type: 'component.heartbeat', attributes: { status: 'unavailable' } })).toBe(false);
  expect((await monitor.status()).dropped).toBe(1);
});
it('does not allow monitoring storage failures to replace the business result', async () => {
  env = await makeEnv();
  const pool = {
    ...env.c.pool,
    connect: async () => {
      throw new Error('private db connection error');
    },
  };
  const monitor = new WarriorMonitor(pool, env.clock, config);
  await expect(monitor.capture(config.apiComponentId, heartbeat)).resolves.toBe(false);
});

it('captures actual converter failure without recording file bytes/names or changing its business error', async () => {
  const { DomainError } = await import('@/lib/server/kernel');
  const error = new DomainError('unavailable', 'synthetic converter outage');
  env = await makeEnv({
    env: {
      WARRIOR_EVENTS_TOKEN: config.token,
      WARRIOR_API_COMPONENT_ID: config.apiComponentId,
      WARRIOR_CONVERTER_COMPONENT_ID: config.converterComponentId,
      WARRIOR_SCANNER_COMPONENT_ID: config.scannerComponentId,
    },
    converter: {
      convert: async () => {
        throw error;
      },
    },
  });
  await expect(
    env.c.conversions.convert({ target: 'pdf', from: 'rtf' }, 'private-customer-name.rtf', new TextEncoder().encode('{\\rtf private document content}')),
  ).rejects.toBe(error);
  const rows = (await env.admin.query('SELECT envelope FROM warrior_outbox')).rows;
  expect(rows.map((r) => r.envelope.type).sort()).toEqual(['component.heartbeat', 'conversion.failed']);
  expect(JSON.stringify(rows)).not.toContain('private');
  expect(JSON.stringify(rows)).not.toContain(config.token);
  const user = await env.user('ordinary@example.test');
  expect((await env.call('GET', '/api/v1/admin/monitoring', { token: user.token })).status).toBe(403);
  const operator = await env.operator('operator@example.test');
  const status = await env.call('GET', '/api/v1/admin/monitoring', { token: operator });
  expect(status.status).toBe(200);
  expect(status.body.pending).toBe(2);
  expect(status.text).not.toContain(config.token);
  expect(status.text).not.toContain('envelope');
});

it('requires matching acknowledgement IDs and rejects oversized upstream bodies without losing pending events', async () => {
  env = await makeEnv();
  let oversized = false;
  const monitor = new WarriorMonitor(env.c.pool, env.clock, config, async (_url, init) =>
    oversized
      ? Response.json({ accepted: [{ id: JSON.parse(init!.body as string).events[0].id, disposition: 'stored' }], padding: 'x'.repeat(33000) })
      : Response.json({ accepted: [{ id: '00000000-0000-4000-8000-000000000001', disposition: 'stored' }] }),
  );
  await monitor.capture(config.apiComponentId, heartbeat);
  await monitor.flush();
  expect((await monitor.status()).pending).toBe(1);
  oversized = true;
  env.clock.advance(300000);
  await monitor.flush();
  expect((await monitor.status()).pending).toBe(1);
  const row = (await env.admin.query('SELECT id,envelope FROM warrior_outbox')).rows[0];
  await expect(env.c.pool.query("UPDATE warrior_outbox SET envelope='{}' WHERE id=$1", [row.id])).rejects.toThrow(/immutable monitor event/);
});

it('keeps a newer worker claim when an older transport completes late', async () => {
  env = await makeEnv();
  let releaseFirst!: () => void, releaseSecond!: () => void, startedFirst!: () => void, startedSecond!: () => void;
  const beganFirst = new Promise<void>((r) => {
      startedFirst = r;
    }),
    beganSecond = new Promise<void>((r) => {
      startedSecond = r;
    });
  const transport =
    (start: () => void, assign: (r: () => void) => void): typeof fetch =>
    async (_url, init) => {
      const batch = JSON.parse(init!.body as string);
      await new Promise<void>((r) => {
        assign(r);
        start();
      });
      return Response.json({ accepted: batch.events.map((e: { id: string }) => ({ id: e.id, disposition: 'stored' })) });
    };
  const first = new WarriorMonitor(
    env.c.pool,
    env.clock,
    config,
    transport(
      () => startedFirst(),
      (r) => {
        releaseFirst = r;
      },
    ),
  );
  const second = new WarriorMonitor(
    env.c.pool,
    env.clock,
    config,
    transport(
      () => startedSecond(),
      (r) => {
        releaseSecond = r;
      },
    ),
  );
  await first.capture(config.apiComponentId, heartbeat);
  const firstPending = first.flush();
  await beganFirst;
  env.clock.advance(16000);
  const secondPending = second.flush();
  await beganSecond;
  releaseFirst();
  await firstPending;
  expect((await first.status()).claimed).toBe(1);
  releaseSecond();
  await secondPending;
  expect((await first.status()).claimed).toBe(0);
  expect((await first.status()).pending).toBe(0);
});
