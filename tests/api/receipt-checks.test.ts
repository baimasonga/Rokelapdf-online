import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import { RECEIPT_DAILY_LIMIT } from '@/lib/server/receipt-checks';

// Receipt checks (docs/receipt-checks.md): the facts behind the QR code on a Receipt Maker document.

let env: TestEnv;
afterEach(async () => env?.close());

const DAY = 86_400_000;
const PATH = '/api/v1/me/receipt-checks';
const SHA = 'b'.repeat(64);
const BODY = {
  kind: 'receipt',
  business_name: 'Kamara & Sons Hardware',
  number: '0457',
  issued_on: '2026-10-24',
  currency: 'NLe',
  total: 1550,
  customer_name: 'Fatmata Sesay',
};
const pub = (code: string) => env.call('GET', `/api/v1/public/receipt-checks/${code}`);

describe('receipt checks', () => {
  it('registers the facts, fingerprints the file once and shows only the facts publicly', async () => {
    env = await makeEnv();
    const u = await env.user('shop@example.test', { verified: true });
    const r = await env.call('POST', PATH, { token: u.token, body: BODY });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'receipt',
      business_name: 'Kamara & Sons Hardware',
      number: '0457',
      issued_on: '2026-10-24',
      total: 1550,
      status: 'active',
    });
    expect(r.body.code).toMatch(/^[A-Z2-7]{16}$/);
    expect(r.body.url).toBe(`${env.c.config.publicOrigin}/receipts/${r.body.code}`);

    const p = await pub(r.body.code);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      business_name: 'Kamara & Sons Hardware',
      number: '0457',
      currency: 'NLe',
      total: 1550,
      customer_name: 'Fatmata Sesay',
      sha256: null,
      status: 'active',
    });
    // Nothing about the issuer's account.
    expect(JSON.stringify(p.body)).not.toMatch(/shop@|usr_|rck_/);
    // Codes are case- and dash-insensitive on the page, like the verified documents.
    expect((await pub(`${r.body.code.slice(0, 8).toLowerCase()}-${r.body.code.slice(8)}`)).status).toBe(200);

    expect((await env.call('POST', `${PATH}/${r.body.id}/digest`, { token: u.token, body: { sha256: SHA } })).body.sha256).toBe(SHA);
    expect((await env.call('POST', `${PATH}/${r.body.id}/digest`, { token: u.token, body: { sha256: 'c'.repeat(64) } })).status).toBe(409);
    expect((await pub(r.body.code)).body.sha256).toBe(SHA);

    const list = await env.call('GET', PATH, { token: u.token });
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([r.body.id]);
  });

  it('lets only the issuer cancel, permanently, and the public page says so', async () => {
    env = await makeEnv();
    const u = await env.user('shop@example.test', { verified: true });
    const other = await env.user('other@example.test', { verified: true });
    const r = await env.call('POST', PATH, { token: u.token, body: { ...BODY, customer_name: undefined } });
    expect(r.body.customer_name).toBeNull();
    expect((await env.call('POST', `${PATH}/${r.body.id}/cancel`, { token: other.token, body: { reason: 'refunded' } })).status).toBe(404);
    expect((await env.call('POST', `${PATH}/${r.body.id}/digest`, { token: other.token, body: { sha256: SHA } })).status).toBe(404);
    expect((await env.call('GET', PATH, { token: other.token })).body.items).toEqual([]);
    const c = await env.call('POST', `${PATH}/${r.body.id}/cancel`, { token: u.token, body: { reason: 'refunded' } });
    expect(c.body).toMatchObject({ status: 'cancelled', cancel_reason: 'refunded' });
    expect((await env.call('POST', `${PATH}/${r.body.id}/cancel`, { token: u.token, body: { reason: 'other' } })).status).toBe(409);
    expect((await pub(r.body.code)).body).toMatchObject({ status: 'cancelled', cancel_reason: 'refunded' });
    // The database refuses deletion and changed facts even for a direct query.
    await expect(env.admin.query('DELETE FROM receipt_checks WHERE id = $1', [r.body.id])).rejects.toThrow(/never deleted/);
    await expect(env.admin.query('UPDATE receipt_checks SET total = 1 WHERE id = $1', [r.body.id])).rejects.toThrow(/immutable/);
  });

  it('answers unknown and malformed codes with the same 404', async () => {
    env = await makeEnv();
    expect((await pub('AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await pub('not-a-code-at-all!!')).status).toBe(404);
  });

  it('needs a signed-in person with a confirmed email and Pro access, and valid facts', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-03-01' } });
    expect((await env.call('POST', PATH, { body: BODY })).status).toBe(401);
    const unconfirmed = await env.user('new@example.test', { verified: false });
    expect((await env.call('POST', PATH, { token: unconfirmed.token, body: BODY })).status).toBe(403);
    const u = await env.user('shop@example.test', { verified: true });
    expect((await env.call('POST', PATH, { token: u.token, body: BODY })).status).toBe(201); // free month
    for (const bad of [{ kind: 'cheque' }, { total: -1 }, { issued_on: '24/10/2026' }, { currency: 'GBP' }, { business_name: '   ' }, { extra: 1 }])
      expect((await env.call('POST', PATH, { token: u.token, body: { ...BODY, ...bad } })).status, JSON.stringify(bad)).toBe(400);
    env.clock.advance(31 * DAY);
    expect((await env.call('POST', PATH, { token: u.token, body: BODY })).status).toBe(403);
  });

  it(`stops at ${RECEIPT_DAILY_LIMIT} registrations a day per person`, async () => {
    env = await makeEnv();
    const u = await env.user('busy@example.test', { verified: true });
    const id = await env.admin.query('SELECT id FROM users WHERE email = $1', ['busy@example.test']);
    await env.admin.query(
      `INSERT INTO receipt_checks (id, user_id, code, kind, business_name, number, issued_on, currency, total, status, created_at)
       SELECT 'rck_' || lpad(to_hex(g), 24, '0'), $1, lpad(translate(to_hex(g), '0189abcdef', 'ABCDEFGHJK'), 16, 'Q'), 'receipt', 'Shop', g::text,
              '2026-03-01', 'NLe', 1, 'active', $2
       FROM generate_series(1, $3::int) g`,
      [id.rows[0].id, env.clock.now(), RECEIPT_DAILY_LIMIT],
    );
    expect((await env.call('POST', PATH, { token: u.token, body: BODY })).status).toBe(429);
    env.clock.advance(DAY + 1000);
    expect((await env.call('POST', PATH, { token: u.token, body: BODY })).status).toBe(201);
  });
});
