import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSINESSES_MAX, MAIN, addBusiness, loadBusinesses, nextActive, saveBusinesses, storeSynced, summaries, syncWorld } from '@/lib/receipts/businesses';
import { loadLedger, saveLedger, type LedgerEntry } from '@/lib/receipts/ledger';
import { DEFAULT_BUSINESS } from '@/lib/receipts/model';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '@/lib/receipts/store';

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const entry = (number: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: 'invoice',
  number,
  date: '2026-10-20',
  due: '',
  customer: 'Sunrise Ltd',
  currency: 'NLe',
  total: 100,
  paidAtIssue: 0,
  updatedAt: 1000,
  ...over,
});

describe('businesses on this device', () => {
  it('starts with none, so a business is set up first', () => {
    expect(loadBusinesses()).toEqual({ active: '', ids: [] });
  });

  it('turns what was made before there were several businesses into the first one, keeping everything', () => {
    savePrefs({ ...DEFAULT_PREFS, business: { ...DEFAULT_BUSINESS, name: 'Kamara Hardware' }, counters: { receipt: 4, invoice: 2, proforma: 0 } });
    saveLedger([entry('INV-0002'), entry('INV-0001')]);
    const list = loadBusinesses();
    expect(list).toEqual({ active: MAIN, ids: [MAIN] });
    expect(loadPrefs(MAIN).business.name).toBe('Kamara Hardware');
    expect(loadPrefs(MAIN).counters.receipt).toBe(4);
    expect(loadLedger(MAIN)).toHaveLength(2);
    // Numbering alone also counts as earlier work.
    stored = new Map();
    savePrefs({ ...DEFAULT_PREFS, counters: { receipt: 1, invoice: 0, proforma: 0 } });
    expect(loadBusinesses().ids).toEqual([MAIN]);
  });

  it('adds businesses with their own settings and ledger, the first one being main', () => {
    let list = loadBusinesses();
    const first = addBusiness(list, { ...DEFAULT_BUSINESS, name: '  Kamara Hardware ' }, 500);
    expect(first.id).toBe(MAIN);
    expect(first.prefs.business.name).toBe('Kamara Hardware');
    expect(first.prefs.businessAt).toBe(500);
    list = first.list;
    saveLedger([entry('INV-0001')], MAIN);
    const second = addBusiness(list, { ...DEFAULT_BUSINESS, name: 'Kamara Transport' });
    expect(second.id).toMatch(/^b[a-z0-9]{10}$/);
    expect(second.list).toEqual({ active: second.id, ids: [MAIN, second.id] });
    expect(loadBusinesses()).toEqual(second.list);
    expect(loadLedger(second.id)).toEqual([]);
    expect(loadLedger(MAIN)).toHaveLength(1);
    expect(loadPrefs(second.id).counters).toEqual({ receipt: 0, invoice: 0, proforma: 0 });
    expect(summaries(second.list).map((s) => s.business.name)).toEqual(['Kamara Hardware', 'Kamara Transport']);
    expect(() => addBusiness(second.list, { ...DEFAULT_BUSINESS, name: ' ' })).toThrow('name');
  });

  it(`stops at ${BUSINESSES_MAX} businesses`, () => {
    let list = loadBusinesses();
    for (let i = 0; i < BUSINESSES_MAX; i++) list = addBusiness(list, { ...DEFAULT_BUSINESS, name: `Shop ${i}` }).list;
    expect(() => addBusiness(list, { ...DEFAULT_BUSINESS, name: 'One too many' })).toThrow(`${BUSINESSES_MAX}`);
  });

  it('moves to another business in use when one is archived', () => {
    let list = addBusiness(loadBusinesses(), { ...DEFAULT_BUSINESS, name: 'A' }).list;
    const b = addBusiness(list, { ...DEFAULT_BUSINESS, name: 'B' });
    list = b.list;
    expect(nextActive(list, b.id)).toBe(MAIN);
    savePrefs({ ...loadPrefs(MAIN), business: { ...loadPrefs(MAIN).business, archived: true } }, MAIN);
    expect(nextActive(list, b.id)).toBe('');
  });

  it('stores a sync for the businesses not on screen, keeping changes made meanwhile, and adds new ones', () => {
    let list = addBusiness(loadBusinesses(), { ...DEFAULT_BUSINESS, name: 'Open one' }).list;
    const other = addBusiness(list, { ...DEFAULT_BUSINESS, name: 'Other' }, 100);
    list = { ...other.list, active: MAIN };
    saveBusinesses(list);
    saveLedger([entry('INV-0005', { updatedAt: 900 })], other.id);
    const world = syncWorld(list, MAIN, { entries: [], counters: DEFAULT_PREFS.counters, business: DEFAULT_BUSINESS, businessAt: 0 });
    expect(world[other.id]!.entries.map((e) => e.number)).toEqual(['INV-0005']);

    const next = storeSynced(list, MAIN, {
      [MAIN]: { entries: [entry('INV-0099')], counters: DEFAULT_PREFS.counters, business: { ...DEFAULT_BUSINESS, name: 'Not stored' }, businessAt: 1 },
      [other.id]: {
        entries: [entry('INV-0004', { updatedAt: 800 })],
        counters: { receipt: 0, invoice: 4, proforma: 0 },
        business: DEFAULT_BUSINESS,
        businessAt: 50,
      },
      bnew: {
        entries: [entry('INV-0001')],
        counters: { receipt: 0, invoice: 1, proforma: 0 },
        business: { ...DEFAULT_BUSINESS, name: 'From the phone' },
        businessAt: 10,
      },
    });
    expect(next).toEqual({ active: MAIN, ids: [MAIN, other.id, 'bnew'] });
    // The open business is left to the screen.
    expect(loadLedger(MAIN)).toEqual([]);
    // The other keeps its own newer profile and both documents; numbering only goes up.
    expect(loadPrefs(other.id).business.name).toBe('Other');
    expect(
      loadLedger(other.id)
        .map((e) => e.number)
        .sort(),
    ).toEqual(['INV-0004', 'INV-0005']);
    expect(loadPrefs(other.id).counters.invoice).toBe(4);
    expect(loadPrefs('bnew').business.name).toBe('From the phone');
    expect(loadLedger('bnew')).toHaveLength(1);
  });

  it('opens a business found in the account when this device has none yet', () => {
    const next = storeSynced(loadBusinesses(), '', {
      [MAIN]: { entries: [], counters: DEFAULT_PREFS.counters, business: { ...DEFAULT_BUSINESS, name: 'Synced shop' }, businessAt: 5 },
    });
    expect(next).toEqual({ active: MAIN, ids: [MAIN] });
    expect(loadPrefs(MAIN).business.name).toBe('Synced shop');
  });
});
