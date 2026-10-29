import { loadLedger, saveLedger } from './ledger';
import type { Business } from './model';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ReceiptPrefs } from './store';
import { applySync, type SyncLocal, type SyncWorld } from './sync';

// The person's businesses in the Receipt Maker, on this device (shared by the website and the Android app). A business
// is set up first; every document, number and ledger entry then belongs to it. Each business keeps its own settings
// (store.ts) and ledger (ledger.ts). The first one is 'main': it holds whatever was made before there were several
// businesses, and it is the one an older version of the app keeps syncing.

export const MAIN = 'main';
/** Businesses one person can keep, archived ones included (the account holds no more). */
export const BUSINESSES_MAX = 10;
const KEY = 'rokela.businesses.v1';
const ID = /^[a-z0-9]{1,24}$/;

export interface BusinessList {
  /** The business being worked in ('' when there is none yet). */
  active: string;
  ids: string[];
}

export interface BusinessSummary {
  id: string;
  business: Business;
}

/** Whether this device holds anything made before there were several businesses. */
function hasLegacy(): boolean {
  const p = loadPrefs(MAIN);
  return !!p.business.name.trim() || Object.values(p.counters).some((n) => n > 0) || loadLedger(MAIN).length > 0;
}

/** The businesses on this device. Data from before there were several becomes the first business. */
export function loadBusinesses(): BusinessList {
  let raw: Partial<BusinessList> | null = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<BusinessList> | null;
  } catch {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.ids)) return hasLegacy() ? { active: MAIN, ids: [MAIN] } : { active: '', ids: [] };
  const ids = [...new Set(raw.ids.filter((x): x is string => typeof x === 'string' && ID.test(x)))];
  const active = typeof raw.active === 'string' && ids.includes(raw.active) ? raw.active : (ids[0] ?? '');
  return { active, ids };
}

export function saveBusinesses(list: BusinessList): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private windows and full storage: the list lasts until the page closes.
  }
}

/** Name, address, logo… of each business on this device, in the order they were added. */
export function summaries(list: BusinessList): BusinessSummary[] {
  return list.ids.map((id) => ({ id, business: loadPrefs(id).business }));
}

/** A new business's id: the first is 'main' (what older app versions sync), later ones are random. */
export function newBusinessId(list: BusinessList): string {
  if (!list.ids.includes(MAIN)) return MAIN;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const id = `b${[...bytes].map((b) => (b % 36).toString(36)).join('')}`;
    if (!list.ids.includes(id)) return id;
  }
}

/** Sets up a new business with its profile and makes it the one being worked in. */
export function addBusiness(list: BusinessList, business: Business, now = Date.now()): { list: BusinessList; id: string; prefs: ReceiptPrefs } {
  if (list.ids.length >= BUSINESSES_MAX) throw new Error(`You can keep at most ${BUSINESSES_MAX} businesses.`);
  if (!business.name.trim()) throw new Error('Give the business a name.');
  const id = newBusinessId(list);
  const prefs: ReceiptPrefs = { ...DEFAULT_PREFS, business: { ...business, name: business.name.trim() }, businessAt: now };
  savePrefs(prefs, id);
  saveLedger([], id);
  const next = { active: id, ids: [...list.ids, id] };
  saveBusinesses(next);
  return { list: next, id, prefs };
}

/** The business to work in after `id` is archived: the first one still in use, or none. */
export function nextActive(list: BusinessList, archived: string): string {
  return list.ids.find((id) => id !== archived && !loadPrefs(id).business.archived) ?? '';
}

const localOf = (prefs: ReceiptPrefs, entries: SyncLocal['entries']): SyncLocal => ({
  entries,
  counters: prefs.counters,
  business: prefs.business,
  businessAt: prefs.businessAt ?? 0,
});

/** What every business on this device holds, for syncing: the open one as shown on screen, the others from storage. */
export function syncWorld(list: BusinessList, open: string, openLocal: SyncLocal): SyncWorld {
  const world: SyncWorld = {};
  for (const id of list.ids) world[id] = id === open ? openLocal : localOf(loadPrefs(id), loadLedger(id));
  return world;
}

/**
 * Stores a sync's result for every business except the open one (the screen applies that one itself), merged with
 * what is stored now so changes made during the sync are kept. Businesses first seen in the account are added.
 */
export function storeSynced(list: BusinessList, open: string, synced: SyncWorld): BusinessList {
  const ids = [...list.ids];
  for (const [id, s] of Object.entries(synced)) {
    if (!ID.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
    if (id === open) continue;
    const prefs = loadPrefs(id);
    const merged = applySync(localOf(prefs, loadLedger(id)), s);
    savePrefs({ ...prefs, counters: merged.counters, business: merged.business, businessAt: merged.businessAt }, id);
    saveLedger(merged.entries, id);
  }
  const next = { active: list.active || ids.find((id) => !loadPrefs(id).business.archived) || '', ids };
  saveBusinesses(next);
  return next;
}
