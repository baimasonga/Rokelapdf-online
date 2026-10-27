import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import type { LedgerEntry } from '@/lib/receipts/ledger';
import { DEFAULT_BUSINESS } from '@/lib/receipts/model';
import { applySync, batches, freshState, syncReceipts, type SyncLocal, type SyncPost } from '@/lib/receipts/sync';

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

  it('takes a business profile saved before sync existed (no edit time) when the account has none', async () => {
    env = await makeEnv();
    const u = await env.user('old@example.test', { verified: true });
    await syncReceipts({ ...empty(), business: { ...DEFAULT_BUSINESS, name: 'Old Shop' }, businessAt: 0 }, freshState('u'), device(u.token), 100);
    // A new device (no profile of its own) takes the account's, whatever its time.
    const other = await syncReceipts(empty(), freshState('u'), device(u.token), 200);
    expect(other.local.business.name).toBe('Old Shop');
    // A device with its own profile and no newer edit keeps it.
    const own = await syncReceipts(
      { ...empty(), business: { ...DEFAULT_BUSINESS, name: 'Mine' }, businessAt: 0 },
      { ...freshState('u'), pushedAt: 50 },
      device(u.token),
      300,
    );
    expect(own.local.business.name).toBe('Mine');
  });

  it('merges two devices updating the profile at the same moment: higher numbers and the newer profile win', async () => {
    env = await makeEnv();
    const u = await env.user('busy@example.test', { verified: true });
    const send = (body: unknown) => env.call('POST', PATH, { token: u.token, body });
    await Promise.all([
      send({ since: 0, counters: { receipt: 9, invoice: 1, proforma: 0 }, business: { data: { ...DEFAULT_BUSINESS, name: 'Newer' }, at: 2000 } }),
      send({ since: 0, counters: { receipt: 3, invoice: 7, proforma: 2 }, business: { data: { ...DEFAULT_BUSINESS, name: 'Older' }, at: 1000 } }),
    ]);
    const r = await send({ since: 0 });
    expect(r.body.counters).toEqual({ receipt: 9, invoice: 7, proforma: 2 });
    expect(r.body.business.name).toBe('Newer');
    // Lower numbers and older profiles never win later either.
    await send({ since: 0, counters: { receipt: 1, invoice: 1, proforma: 1 }, business: { data: { ...DEFAULT_BUSINESS, name: 'Stale' }, at: 1500 } });
    const again = await send({ since: 0 });
    expect(again.body.counters).toEqual({ receipt: 9, invoice: 7, proforma: 2 });
    expect(again.body.business.name).toBe('Newer');
  });

  it('keeps every request under the API size limit, even with long numbers and names', async () => {
    env = await makeEnv();
    const u = await env.user('long@example.test', { verified: true });
    const long = Array.from({ length: 450 }, (_, i) =>
      entry(`${'N'.repeat(34)}-${String(i).padStart(4, '0')}`, { customer: 'C'.repeat(120), against: 'A'.repeat(40) }),
    );
    const parts = batches(long, 500);
    expect(parts.length).toBeGreaterThan(2);
    for (const b of parts) expect(JSON.stringify({ since: 0, entries: b }).length).toBeLessThan(64 * 1024);
    const r = await syncReceipts({ ...empty(), entries: long }, freshState('u'), device(u.token), 100);
    expect(r.local.entries).toHaveLength(450);
    expect((await syncReceipts(empty(), freshState('u'), device(u.token), 200)).local.entries).toHaveLength(450);
  });

  it('keeps changes made on this device while a sync was running', () => {
    const synced: SyncLocal = { ...empty(), entries: [entry('INV-1', { updatedAt: 100 })], counters: { receipt: 0, invoice: 1, proforma: 0 } };
    const now: SyncLocal = {
      entries: [entry('INV-2', { updatedAt: 150 }), entry('INV-1', { void: true, updatedAt: 160 })],
      counters: { receipt: 0, invoice: 2, proforma: 0 },
      business: { ...DEFAULT_BUSINESS, name: 'Edited meanwhile' },
      businessAt: 170,
    };
    const a = applySync(now, { ...synced, business: { ...DEFAULT_BUSINESS, name: 'From the sync' }, businessAt: 120 });
    expect(a.entries.map((e) => `${e.number}${e.void ? ' void' : ''}`).sort()).toEqual(['INV-1 void', 'INV-2']);
    expect(a.counters.invoice).toBe(2);
    expect(a.business.name).toBe('Edited meanwhile');
  });
});
