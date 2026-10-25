import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import { grantLicense, revokeLicense, showLicense } from '@/lib/server/admin';
import { loadConfig } from '@/lib/server/config';
import { canUsePaid, resolveAccess, PAID_FEATURES } from '@/lib/licensing';

// Paid tools (src/lib/licensing.ts): free for everyone before the launch date, then a free month per person from
// their first sign-in, then a yearly licence tied to their email. The test clock starts at 2026-03-01T00:00Z.

let env: TestEnv;
afterEach(async () => env?.close());

const DAY = 86_400_000;
const access = async (token: string) => (await env.call('GET', '/api/v1/me/access', { token })).body;

describe('access to the paid tools', () => {
  it('stays open for everyone when no launch date is set, or before it', async () => {
    env = await makeEnv();
    const u = await env.user('early@example.test', { verified: true });
    expect(await access(u.token)).toMatchObject({ access: 'open', until: null, features: [...PAID_FEATURES], trial_days: 30 });
    expect((await env.call('GET', '/api/v1/config')).body.paid_features_from).toBeNull();
    await env.close();

    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-04-01' } });
    const v = await env.user('soon@example.test', { verified: true });
    expect(await access(v.token)).toEqual(expect.objectContaining({ access: 'open', until: '2026-04-01T00:00:00.000Z' }));
    expect((await env.call('GET', '/api/v1/config')).body.paid_features_from).toBe('2026-04-01T00:00:00.000Z');
    expect((await env.call('GET', '/api/v1/me/access')).status).toBe(401);
  });

  it('gives each person a free month from their first sign-in, then nothing', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-03-01' } });
    env.clock.advance(5 * DAY);
    const u = await env.user('new@example.test', { verified: true });
    expect(await access(u.token)).toMatchObject({ access: 'trial', until: '2026-04-05T00:00:00.000Z' });
    env.clock.advance(29 * DAY);
    expect((await access(u.token)).access).toBe('trial');
    env.clock.advance(DAY);
    expect(await access(u.token)).toMatchObject({ access: 'none', until: null, reason: 'trial_ended' });
  });

  it('starts the free month at launch for people who signed in before it', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-03-11' } });
    const u = await env.user('before@example.test', { verified: true });
    env.clock.advance(20 * DAY);
    expect(await access(u.token)).toMatchObject({ access: 'trial', until: '2026-04-10T00:00:00.000Z' });
  });

  it('needs a confirmed email, so an unconfirmed sign-up cannot use a licence or a trial', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-03-01' } });
    await env.operator('ops@example.test');
    await grantLicense(env.admin, { email: 'owner@example.test', byEmail: 'ops@example.test', reason: 'paid by mobile money', now: env.clock.now() });
    const u = await env.user('owner@example.test', { verified: false });
    expect(await access(u.token)).toMatchObject({ access: 'none', reason: 'verify_email' });
  });

  it('honours a yearly licence granted to an email, renews it from its end, and ends it on revoke', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-01-01' } });
    await env.operator('ops@example.test');
    // Granted before the person ever signs in, with a capitalised address.
    const g = await grantLicense(env.admin, { email: ' Pay@Example.test ', byEmail: 'ops@example.test', reason: 'paid by mobile money', now: env.clock.now() });
    expect(g.validUntil.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    const u = await env.user('pay@example.test', { verified: true });
    expect(await access(u.token)).toMatchObject({ access: 'license', until: '2027-03-01T00:00:00.000Z' });

    env.clock.advance(100 * DAY);
    const renewed = await grantLicense(env.admin, { email: 'pay@example.test', byEmail: 'ops@example.test', reason: 'renewed early', now: env.clock.now() });
    expect([renewed.validFrom.toISOString(), renewed.validUntil.toISOString()]).toEqual(['2026-03-01T00:00:00.000Z', '2028-02-29T00:00:00.000Z']);

    await revokeLicense(env.admin, { email: 'pay@example.test', byEmail: 'ops@example.test', reason: 'refunded', now: env.clock.now() });
    // The free month (from 2026-03-01) has long passed, so nothing is left.
    expect(await access(u.token)).toMatchObject({ access: 'none', reason: 'license_ended' });
    expect(await revokeLicense(env.admin, { email: 'pay@example.test', byEmail: 'ops@example.test', reason: 'again', now: env.clock.now() })).toMatchObject({
      changed: false,
    });
    expect((await showLicense(env.admin, 'PAY@example.test'))?.reason).toBe('refunded');

    const ev = await env.admin.query("SELECT action, actor_type, target_type, target_id, reason FROM audit_events WHERE action LIKE 'license.%' ORDER BY seq");
    expect(ev.rows).toEqual([
      { action: 'license.granted', actor_type: 'operator', target_type: 'license', target_id: 'pay@example.test', reason: 'paid by mobile money' },
      { action: 'license.granted', actor_type: 'operator', target_type: 'license', target_id: 'pay@example.test', reason: 'renewed early' },
      { action: 'license.revoked', actor_type: 'operator', target_type: 'license', target_id: 'pay@example.test', reason: 'refunded' },
    ]);
  });

  it('lets only operators change licences, with a reason, a valid email and 1 to 5 years', async () => {
    env = await makeEnv();
    await env.user('notops@example.test', { verified: true });
    await env.operator('ops@example.test');
    const base = { email: 'a@example.test', byEmail: 'ops@example.test', reason: 'paid' };
    await expect(grantLicense(env.admin, { ...base, byEmail: 'notops@example.test' })).rejects.toThrow(/only operators/);
    await expect(grantLicense(env.admin, { ...base, reason: '' })).rejects.toThrow(/reason/);
    await expect(grantLicense(env.admin, { ...base, email: 'not-an-email' })).rejects.toThrow(/valid email/);
    for (const years of [0, 6, 1.5]) await expect(grantLicense(env.admin, { ...base, years })).rejects.toThrow(/years/);
    await expect(revokeLicense(env.admin, { ...base, email: 'none@example.test' })).rejects.toThrow(/no licence/);
    expect((await grantLicense(env.admin, { ...base, years: 2, now: new Date('2026-03-01T00:00:00Z') })).validUntil.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('answers the Android app cross-origin', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-03-01' } });
    const u = await env.user('app@example.test', { verified: true });
    const r = await env.call('GET', '/api/v1/me/access', { token: u.token, headers: { origin: 'https://localhost' } });
    expect([r.status, r.headers.get('access-control-allow-origin'), r.body.access]).toEqual([200, 'https://localhost', 'trial']);
  });

  it('refuses a launch date it cannot read', () => {
    const base = { APP_ENV: 'test', DATABASE_URL: 'postgres://x/y', PUBLIC_ORIGIN: 'http://localhost:3000' } as unknown as NodeJS.ProcessEnv;
    for (const bad of ['soon', '01/12/2026', '2026-13-45'])
      expect(() => loadConfig({ ...base, PAID_FEATURES_FROM: bad } as NodeJS.ProcessEnv), bad).toThrow(/PAID_FEATURES_FROM/);
    expect(loadConfig({ ...base, PAID_FEATURES_FROM: '2026-12-01' } as NodeJS.ProcessEnv).paidFeaturesFrom?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('a cached answer in the app', () => {
  const now = new Date('2026-05-01T00:00:00Z');
  it('allows the paid tools only while the answer still holds', () => {
    expect(canUsePaid(undefined, now)).toBe(false);
    expect(canUsePaid({ access: 'open', until: null }, now)).toBe(true);
    expect(canUsePaid({ access: 'open', until: '2026-04-01T00:00:00Z' }, now)).toBe(false); // launched since
    expect(canUsePaid({ access: 'trial', until: '2026-05-02T00:00:00Z' }, now)).toBe(true);
    expect(canUsePaid({ access: 'license', until: '2026-04-30T00:00:00Z' }, now)).toBe(false);
    expect(canUsePaid({ access: 'none', until: null, reason: 'trial_ended' }, now)).toBe(false);
  });
  it('prefers a running licence to the free month', () => {
    const r = resolveAccess({
      now,
      paidFrom: new Date('2026-04-20T00:00:00Z'),
      firstSeen: now,
      emailVerified: true,
      license: { from: new Date('2026-04-01T00:00:00Z'), until: new Date('2027-04-01T00:00:00Z') },
    });
    expect(r).toEqual({ access: 'license', until: '2027-04-01T00:00:00.000Z' });
  });
});
