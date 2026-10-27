import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import type { LedgerEntry } from '@/lib/receipts/ledger';
import { DEFAULT_BUSINESS } from '@/lib/receipts/model';
import { freshState, syncReceipts, type SyncLocal, type SyncPost } from '@/lib/receipts/sync';

// Receipt Maker sync (docs/receipt-sync.md): the website and the app share a ledger, numbering and business profile
// through the account. Two "devices" run the real client sync against the real API.

let env: TestEnv;
afterEach(async () => env?.close());

const PATH = '/api/v1/me/receipt-sync';
const entry = (number: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: 'invoice',
  number,
  date: '2026-10-20',
  due: '2026-11-19',
  customer: 'Sunrise Ltd',
  currency: 'NLe',
  total: 1000,
  paidAtIssue: 0,
  updatedAt: 1000,
  ...over,
});
const empty = (): SyncLocal => ({ entries: [], counters: { receipt: 0, invoice: 0, proforma: 0 }, business: DEFAULT_BUSINESS, businessAt: 0 });
function device(token: string): SyncPost {
  return async (body) => {
    const r = await env.call('POST', PATH, { token, body });
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    return r.body as never;
  };
}

describe('receipt sync', () => {
  it('shares documents, numbering and the business profile between two devices, the newer copy winning', async () => {
    env = await makeEnv();
    const u = await env.user('shop@example.test', { verified: true });
    const phone = device(u.token);
    const web = device(u.token);

    // The phone has two invoices, numbering at 2, and a business profile with a logo.
    let p = await syncReceipts(
      {
        entries: [entry('INV-0002', { updatedAt: 2000 }), entry('INV-0001')],
        counters: { receipt: 0, invoice: 2, proforma: 0 },
        business: { ...DEFAULT_BUSINESS, name: 'Kamara & Sons', logo: 'data:image/png;base64,AAAA' },
        businessAt: 500,
      },
      freshState('u'),
      phone,
      3000,
    );
    expect(p.state.cursor).toBeGreaterThan(0);

    // The website starts empty and gets everything except the logo.
    let w = await syncReceipts(empty(), freshState('u'), web, 3100);
    expect(w.local.entries.map((e) => e.number)).toEqual(['INV-0002', 'INV-0001']);
    expect(w.local.counters.invoice).toBe(2);
    expect(w.local.business.name).toBe('Kamara & Sons');
    expect(w.local.business.logo).toBeUndefined();

    // The website records a payment and cancels INV-0002; the phone makes INV-0003 at the same time.
    w = await syncReceipts(
      {
        ...w.local,
        entries: [
          entry('0001', { kind: 'receipt', due: '', against: 'INV-0001', total: 400, updatedAt: 4000 }),
          ...w.local.entries.map((e) => (e.number === 'INV-0002' ? { ...e, void: true, updatedAt: 4100 } : e)),
        ],
        counters: { ...w.local.counters, receipt: 1 },
      },
      w.state,
      web,
      4200,
    );
    p = await syncReceipts(
      { ...p.local, entries: [entry('INV-0003', { updatedAt: 4150 }), ...p.local.entries], counters: { ...p.local.counters, invoice: 3 } },
      p.state,
      phone,
      4300,
    );
    expect(p.local.entries.map((e) => `${e.kind} ${e.number}${e.void ? ' void' : ''}`).sort()).toEqual([
      'invoice INV-0001',
      'invoice INV-0002 void',
      'invoice INV-0003',
      'receipt 0001',
    ]);
    expect(p.local.counters).toEqual({ receipt: 1, invoice: 3, proforma: 0 });
    // The phone keeps its own logo.
    expect(p.local.business.logo).toBe('data:image/png;base64,AAAA');

    // An older copy never overwrites a newer one.
    await syncReceipts({ ...empty(), entries: [entry('INV-0002', { updatedAt: 1 })] }, freshState('u'), web, 5000);
    w = await syncReceipts(empty(), freshState('u'), web, 5100);
    expect(w.local.entries.find((e) => e.number === 'INV-0002')?.void).toBe(true);
    expect(w.local.entries).toHaveLength(4);
  });

  it('keeps each person to their own records, and pages long histories', async () => {
    env = await makeEnv();
    const a = await env.user('a@example.test', { verified: true });
    const b = await env.user('b@example.test', { verified: true });
    const many = Array.from({ length: 650 }, (_, i) => entry(`INV-${1000 + i}`));
    await syncReceipts({ ...empty(), entries: many }, freshState('a'), device(a.token), 9000);
    const fromA = await syncReceipts(empty(), freshState('a'), device(a.token), 9100);
    expect(fromA.local.entries).toHaveLength(650);
    const fromB = await syncReceipts(empty(), freshState('b'), device(b.token), 9100);
    expect(fromB.local.entries).toHaveLength(0);
  });

  it('lets anyone read their own records, but changing them needs a confirmed email and Pro access', async () => {
    env = await makeEnv({ env: { PAID_FEATURES_FROM: '2026-01-01' } });
    expect((await env.call('POST', PATH, { body: { since: 0 } })).status).toBe(401);
    const unconfirmed = await env.user('new@example.test', { verified: false });
    expect((await env.call('POST', PATH, { token: unconfirmed.token, body: { since: 0 } })).status).toBe(403);
    // The free month (from the first sign-in, 2026-03-01 on the test clock) has ended.
    const u = await env.user('late@example.test', { verified: true });
    env.clock.advance(40 * 86_400_000);
    expect((await env.call('POST', PATH, { token: u.token, body: { since: 0 } })).status).toBe(200);
    expect((await env.call('POST', PATH, { token: u.token, body: { since: 0, entries: [entry('INV-1')] } })).status).toBe(403);
    // Too many in one request, or a malformed body.
    const v = await env.user('ok@example.test', { verified: true });
    const tooMany = Array.from({ length: 201 }, (_, i) => entry(`X-${i}`));
    expect((await env.call('POST', PATH, { token: v.token, body: { since: 0, entries: tooMany } })).status).toBe(400);
    expect((await env.call('POST', PATH, { token: v.token, body: { since: -1 } })).status).toBe(400);
  });
});
