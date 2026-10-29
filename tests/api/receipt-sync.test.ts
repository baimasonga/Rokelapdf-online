import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import type { LedgerEntry } from '@/lib/receipts/ledger';
import { DEFAULT_BUSINESS } from '@/lib/receipts/model';
import { applySync, batches, freshState, freshWorldState, syncBusinesses, syncReceipts, type SyncLocal, type SyncPost } from '@/lib/receipts/sync';

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

  it('keeps several businesses apart, each with its own documents, numbering and profile', async () => {
    env = await makeEnv();
    const u = await env.user('two@example.test', { verified: true });
    const shop: SyncLocal = {
      entries: [entry('INV-0001', { customer: 'Sunrise Ltd', updatedAt: 1000 })],
      counters: { receipt: 0, invoice: 1, proforma: 0 },
      business: { ...DEFAULT_BUSINESS, name: 'Kamara Hardware', logo: 'data:image/png;base64,AAAA' },
      businessAt: 900,
    };
    const transport: SyncLocal = {
      entries: [entry('INV-0001', { customer: 'Freetown Port', total: 5000, updatedAt: 1100 })],
      counters: { receipt: 0, invoice: 1, proforma: 0 },
      business: { ...DEFAULT_BUSINESS, name: 'Kamara Transport' },
      businessAt: 950,
    };
    const phone = await syncBusinesses({ main: shop, btransport: transport }, freshWorldState('u'), device(u.token), 2000);
    expect(phone.state.cursor).toBeGreaterThan(0);

    // A new device gets both businesses, each with only its own INV-0001 (the same number, kept apart).
    const web = await syncBusinesses({}, freshWorldState('u'), device(u.token), 2100);
    expect(Object.keys(web.world).sort()).toEqual(['btransport', 'main']);
    expect(web.world.main!.business.name).toBe('Kamara Hardware');
    expect(web.world.main!.business.logo).toBeUndefined();
    expect(web.world.main!.entries.map((e) => e.customer)).toEqual(['Sunrise Ltd']);
    expect(web.world.btransport!.business.name).toBe('Kamara Transport');
    expect(web.world.btransport!.entries.map((e) => `${e.number} ${e.customer} ${e.total}`)).toEqual(['INV-0001 Freetown Port 5000']);
    expect(web.world.btransport!.counters.invoice).toBe(1);

    // The website archives the transport business and makes INV-0002 there; the phone gets both changes and keeps its logo.
    const t = web.world.btransport!;
    const web2 = await syncBusinesses(
      {
        ...web.world,
        btransport: {
          ...t,
          entries: [entry('INV-0002', { customer: 'Bo Market', updatedAt: 3000 }), ...t.entries],
          counters: { ...t.counters, invoice: 2 },
          business: { ...t.business, archived: true },
          businessAt: 3000,
        },
      },
      web.state,
      device(u.token),
      3100,
    );
    expect(web2.world.btransport!.counters.invoice).toBe(2);
    const phone2 = await syncBusinesses(phone.world, phone.state, device(u.token), 3200);
    expect(phone2.world.btransport!.business.archived).toBe(true);
    expect(phone2.world.btransport!.entries.map((e) => e.number).sort()).toEqual(['INV-0001', 'INV-0002']);
    expect(phone2.world.btransport!.counters.invoice).toBe(2);
    expect(phone2.world.main!.entries).toHaveLength(1);
    expect(phone2.world.main!.business.logo).toBe('data:image/png;base64,AAAA');
  });

  it('shows an older app version only the first business, and keeps what it sends there', async () => {
    env = await makeEnv();
    const u = await env.user('old-app@example.test', { verified: true });
    await syncBusinesses(
      {
        main: { ...empty(), entries: [entry('INV-0001')], business: { ...DEFAULT_BUSINESS, name: 'First' }, businessAt: 10 },
        bsecond: { ...empty(), entries: [entry('INV-0009')], business: { ...DEFAULT_BUSINESS, name: 'Second' }, businessAt: 10 },
      },
      freshWorldState('u'),
      device(u.token),
      100,
    );
    // The single-business protocol (no business id): only the first business, in the old answer's shape.
    const old = await syncReceipts({ ...empty(), entries: [entry('INV-0002', { updatedAt: 200 })] }, freshState('u'), device(u.token), 300);
    expect(old.local.business.name).toBe('First');
    expect(old.local.entries.map((e) => e.number).sort()).toEqual(['INV-0001', 'INV-0002']);
    const raw = await env.call('POST', PATH, { token: u.token, body: { since: 0 } });
    expect(raw.body.businesses).toBeUndefined();
    expect(raw.body.entries.every((e: Record<string, unknown>) => !('business_id' in e))).toBe(true);
    // What the older app sent is in the first business only.
    const now = await syncBusinesses({}, freshWorldState('u'), device(u.token), 400);
    expect(now.world.main!.entries.map((e) => e.number).sort()).toEqual(['INV-0001', 'INV-0002']);
    expect(now.world.bsecond!.entries.map((e) => e.number)).toEqual(['INV-0009']);
  });

  it('keeps a person to ten businesses and checks business ids', async () => {
    env = await makeEnv();
    const u = await env.user('many@example.test', { verified: true });
    const send = (body: unknown) => env.call('POST', PATH, { token: u.token, body });
    for (let i = 0; i < 10; i++)
      expect((await send({ since: 0, business_id: `b${i}`, business: { data: { ...DEFAULT_BUSINESS, name: `Shop ${i}` }, at: 1 } })).status).toBe(200);
    const eleventh = await send({ since: 0, business_id: 'b10', business: { data: { ...DEFAULT_BUSINESS, name: 'One too many' }, at: 1 } });
    expect(eleventh.status).toBe(409);
    // A business already there can still be changed.
    expect((await send({ since: 0, business_id: 'b3', entries: [entry('INV-1')] })).status).toBe(200);
    expect((await send({ since: 0, business_id: 'Not Valid!' })).status).toBe(400);
    const all = await send({ since: 0, all: true });
    expect(all.body.businesses).toHaveLength(10);
    expect(all.body.entries).toEqual([expect.objectContaining({ number: 'INV-1', business_id: 'b3' })]);
  });

  it('keeps syncing the other businesses when the account has no room for one more', async () => {
    env = await makeEnv();
    const u = await env.user('full@example.test', { verified: true });
    const send = (body: unknown) => env.call('POST', PATH, { token: u.token, body });
    // Another device already filled the account with ten businesses.
    for (let i = 0; i < 10; i++) await send({ since: 0, business_id: `b${i}`, business: { data: { ...DEFAULT_BUSINESS, name: `Shop ${i}` }, at: 1 } });
    // This device has one of them with a new invoice, and an eleventh business of its own.
    const world = {
      b3: { ...empty(), entries: [entry('INV-0042', { updatedAt: 500 })], business: { ...DEFAULT_BUSINESS, name: 'Shop 3' }, businessAt: 1 },
      bextra: { ...empty(), entries: [entry('INV-0001')], business: { ...DEFAULT_BUSINESS, name: 'One too many' }, businessAt: 2 },
    };
    const r = await syncBusinesses(world, freshWorldState('u'), device(u.token), 1000);
    expect(r.state.retry).toEqual(['bextra']);
    // The other business's invoice reached the account, and this device learned of all ten.
    expect(Object.keys(r.world).filter((id) => id !== 'bextra')).toHaveLength(10);
    const elsewhere = await syncBusinesses({}, freshWorldState('u'), device(u.token), 1100);
    expect(elsewhere.world.b3!.entries.map((e) => e.number)).toEqual(['INV-0042']);
    expect(elsewhere.world.bextra).toBeUndefined();
    // The eleventh stays on this device with everything in it, and is tried again in full next time.
    expect(r.world.bextra!.entries.map((e) => e.number)).toEqual(['INV-0001']);
    const sent: unknown[] = [];
    const again = await syncBusinesses(r.world, r.state, async (body) => (sent.push(body), device(u.token)(body)), 2000);
    expect(sent.some((b) => (b as { business_id?: string }).business_id === 'bextra')).toBe(true);
    expect(again.state.retry).toEqual(['bextra']);
  });
});
