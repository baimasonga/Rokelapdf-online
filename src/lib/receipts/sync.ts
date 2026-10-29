import { LEDGER_MAX, byNewest, cleanEntry, entryKey, type LedgerEntry } from './ledger';
import type { Business, DocKind } from './model';
import { cleanBusiness } from './store';

// Syncing the Receipt Maker through the person's account (docs/receipt-sync.md), shared by the website and the Android
// app: send what changed here since the last sync, take what changed elsewhere, and merge, business by business. The
// newer copy of a document wins, numbering only goes up, the newer business profile wins (the logo stays on each
// device). syncBusinesses is what the apps use; syncReceipts is the single-business protocol older app versions still
// speak, which the server keeps answering for the first business.

const KEY = 'rokela.receipts.sync';
const PUSH_MAX = 200;
/** Request bodies stay under this many characters (the API refuses more than 64 KiB). */
const PUSH_CHARS = 48_000;

type Counters = Record<DocKind, number>;

/** What this device holds. */
export interface SyncLocal {
  entries: LedgerEntry[];
  counters: Counters;
  business: Business;
  businessAt: number;
}

/** Where this device is in the account's history, for one signed-in person. */
export interface SyncState {
  user: string;
  /** The last cursor the server gave (0: never synced). */
  cursor: number;
  /** Changes made after this moment (ms) are still to be sent (-1: send everything). */
  pushedAt: number;
  /** The numbering last sent, so unchanged numbering is not sent again. */
  counters: Counters;
}

/** The API's answer (its keys are snake_case on the wire, so business_at). */
interface Answer {
  cursor: number;
  more: boolean;
  entries: unknown[];
  counters: Counters;
  business: unknown;
  business_at?: number;
  businessAt?: number;
  /** When every business was asked for. */
  businesses?: Array<{ id: string; counters: Counters; business: unknown; business_at?: number; businessAt?: number }>;
}

/** POSTs to /api/v1/me/receipt-sync as the signed-in person (each caller adds its own auth). */
export type SyncPost = (body: unknown) => Promise<Answer>;

const ZERO: Counters = { receipt: 0, invoice: 0, proforma: 0 };
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const maxCounters = (a: Counters, b: Partial<Counters>): Counters => ({
  receipt: Math.max(a.receipt, n(b.receipt)),
  invoice: Math.max(a.invoice, n(b.invoice)),
  proforma: Math.max(a.proforma, n(b.proforma)),
});

export function freshState(user: string): SyncState {
  return { user, cursor: 0, pushedAt: -1, counters: ZERO };
}

/** Merges documents from another device: the newer copy of each document wins. */
export function mergeEntries(local: LedgerEntry[], incoming: LedgerEntry[]): LedgerEntry[] {
  const all = new Map(local.map((e) => [entryKey(e), e]));
  for (const e of incoming) {
    const mine = all.get(entryKey(e));
    if (!mine || (e.updatedAt ?? 0) > (mine.updatedAt ?? 0)) all.set(entryKey(e), e);
  }
  return [...all.values()].sort(byNewest).slice(0, LEDGER_MAX);
}

/** One full sync: send what is waiting here, then take everything new from the account. */
/** Splits documents into requests of at most PUSH_MAX documents and PUSH_CHARS characters (the first also carries `extra`). */
export function batches(entries: LedgerEntry[], extra = 0): LedgerEntry[][] {
  const out: LedgerEntry[][] = [[]];
  let size = 200 + extra;
  for (const e of entries) {
    const len = JSON.stringify(e).length + 1;
    const cur = out[out.length - 1]!;
    if (cur.length && (cur.length >= PUSH_MAX || size + len > PUSH_CHARS)) {
      out.push([e]);
      size = 200 + len;
    } else {
      cur.push(e);
      size += len;
    }
  }
  return out;
}

/**
 * The result of a sync applied to what this device holds *now*: documents, numbering or business details changed here
 * while the sync was running are newer than the sync's copy, so they are kept (and sent next time).
 */
export function applySync(current: SyncLocal, synced: SyncLocal): SyncLocal {
  const theirs = synced.businessAt > current.businessAt || (!current.business.name.trim() && !!synced.business.name.trim());
  return {
    entries: mergeEntries(current.entries, synced.entries),
    counters: maxCounters(current.counters, synced.counters),
    business: theirs ? { ...synced.business, logo: current.business.logo } : current.business,
    businessAt: theirs ? synced.businessAt : current.businessAt,
  };
}

export async function syncReceipts(local: SyncLocal, state: SyncState, post: SyncPost, now = Date.now()): Promise<{ local: SyncLocal; state: SyncState }> {
  const waiting = local.entries.filter((e) => (e.updatedAt ?? 0) > state.pushedAt);
  const countersChanged = (Object.keys(ZERO) as DocKind[]).some((k) => local.counters[k] > state.counters[k]);
  const businessChanged = local.businessAt > state.pushedAt && !!local.business.name.trim();
  let answer: Answer | undefined;
  const profile = {
    ...(countersChanged ? { counters: local.counters } : {}),
    ...(businessChanged ? { business: { data: { ...local.business, logo: undefined }, at: local.businessAt } } : {}),
  };
  for (const [i, batch] of batches(waiting, JSON.stringify(profile).length).entries())
    if (batch.length || (i === 0 && (countersChanged || businessChanged)))
      answer = await post({ since: state.cursor, entries: batch, ...(i === 0 ? profile : {}) });
  // Take everything that changed in the account since this device last looked (including what it just sent).
  let cursor = state.cursor;
  let incoming: LedgerEntry[] = [];
  do {
    answer = await post({ since: cursor, entries: [] });
    incoming = incoming.concat(answer.entries.map(cleanEntry).filter((e): e is LedgerEntry => !!e));
    cursor = answer.cursor;
  } while (answer.more);
  const counters = maxCounters(local.counters, answer.counters);
  const theirAt = n(answer.businessAt ?? answer.business_at);
  // The account's profile wins when it is newer, or when this device has none yet (whatever its time).
  const theirs = answer.business && (theirAt > local.businessAt || !local.business.name.trim()) ? cleanBusiness(answer.business) : undefined;
  return {
    local: {
      entries: mergeEntries(local.entries, incoming),
      counters,
      business: theirs ? { ...theirs, logo: local.business.logo } : local.business,
      businessAt: theirs ? theirAt : local.businessAt,
    },
    // Anything changed from the moment this sync started is sent next time.
    state: { user: state.user, cursor, pushedAt: now - 1, counters },
  };
}

export function loadSyncState(user: string): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SyncState | null;
    if (s && s.user === user && Number.isFinite(s.cursor) && Number.isFinite(s.pushedAt) && s.counters)
      return { ...s, counters: maxCounters(ZERO, s.counters) };
  } catch {
    /* damaged: start again, which only re-sends */
  }
  return freshState(user);
}

export function saveSyncState(s: SyncState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable: the next sync sends again, which is harmless */
  }
}

// ---- several businesses ---------------------------------------------------------------------------------------
const WORLD_KEY = 'rokela.receipts.sync2';

/** What each business on this device holds, by business id. */
export type SyncWorld = Record<string, SyncLocal>;

/** Where this device is in the account's history, for one signed-in person and all their businesses. */
export interface WorldState {
  user: string;
  cursor: number;
  /** Changes made after this moment (ms) are still to be sent (-1: send everything). */
  pushedAt: number;
  /** The numbering last sent, per business. */
  counters: Record<string, Counters>;
  /** Businesses the account turned away (it already holds as many as it can): sent in full again each time. */
  retry?: string[];
}

export function freshWorldState(user: string): WorldState {
  return { user, cursor: 0, pushedAt: -1, counters: {} };
}

/** The account already holds as many businesses as it can (the server's answer to a new one beyond the limit). */
const isLimit = (e: unknown) => /at most \d+ businesses/i.test((e as Error)?.message ?? '');

/** One business's data after a sync: its documents, numbering and profile merged with the account's. */
function mergeOne(local: SyncLocal, incoming: LedgerEntry[], counters: Partial<Counters> | undefined, business: unknown, businessAt: number): SyncLocal {
  // The account's profile wins when it is newer, or when this device has none yet (whatever its time).
  const theirs = business && (businessAt > local.businessAt || !local.business.name.trim()) ? cleanBusiness(business) : undefined;
  return {
    entries: mergeEntries(local.entries, incoming),
    counters: maxCounters(local.counters, counters ?? {}),
    business: theirs ? { ...theirs, logo: local.business.logo } : local.business,
    businessAt: theirs ? businessAt : local.businessAt,
  };
}

/** An empty business, for one that so far exists only in the account. */
const blank = (): SyncLocal => ({ entries: [], counters: ZERO, business: cleanBusiness({}), businessAt: 0 });

/**
 * One full sync of every business: send what is waiting here for each one, then take everything new in the account,
 * including businesses set up on another device.
 */
export async function syncBusinesses(world: SyncWorld, state: WorldState, post: SyncPost, now = Date.now()): Promise<{ world: SyncWorld; state: WorldState }> {
  const retry: string[] = [];
  for (const [id, local] of Object.entries(world)) {
    // A business the account turned away last time is sent in full again, in case there is room for it now.
    const again = state.retry?.includes(id) ?? false;
    const since = again ? -1 : state.pushedAt;
    const sent = again ? ZERO : (state.counters[id] ?? ZERO);
    const waiting = local.entries.filter((e) => (e.updatedAt ?? 0) > since);
    const countersChanged = (Object.keys(ZERO) as DocKind[]).some((k) => local.counters[k] > sent[k]);
    const businessChanged = local.businessAt > since && !!local.business.name.trim();
    const profile = {
      ...(countersChanged ? { counters: local.counters } : {}),
      ...(businessChanged ? { business: { data: { ...local.business, logo: undefined }, at: local.businessAt } } : {}),
    };
    try {
      for (const [i, batch] of batches(waiting, JSON.stringify(profile).length + 40).entries())
        if (batch.length || (i === 0 && (countersChanged || businessChanged)))
          await post({ since: state.cursor, business_id: id, entries: batch, ...(i === 0 ? profile : {}) });
    } catch (e) {
      // One business too many must not stop the others syncing: it stays on this device and is tried again later.
      if (!isLimit(e)) throw e;
      retry.push(id);
    }
  }
  // Take everything that changed in the account since this device last looked (including what it just sent).
  let cursor = state.cursor;
  const incoming: Record<string, LedgerEntry[]> = {};
  let answer: Answer;
  do {
    answer = await post({ since: cursor, entries: [], all: true });
    for (const raw of answer.entries) {
      const r = raw as Record<string, unknown>;
      const id = typeof (r.business_id ?? r.businessId) === 'string' ? String(r.business_id ?? r.businessId) : 'main';
      const e = cleanEntry(raw);
      if (e) (incoming[id] ??= []).push(e);
    }
    cursor = answer.cursor;
  } while (answer.more);
  const profiles = new Map((answer.businesses ?? []).map((b) => [b.id, b]));
  const ids = new Set([...Object.keys(world), ...profiles.keys(), ...Object.keys(incoming)]);
  const out: SyncWorld = {};
  const counters: Record<string, Counters> = {};
  for (const id of ids) {
    const p = profiles.get(id);
    out[id] = mergeOne(world[id] ?? blank(), incoming[id] ?? [], p?.counters, p?.business, n(p?.businessAt ?? p?.business_at));
    counters[id] = out[id].counters;
  }
  // Anything changed from the moment this sync started is sent next time.
  return { world: out, state: { user: state.user, cursor, pushedAt: now - 1, counters, ...(retry.length ? { retry } : {}) } };
}

export function loadWorldState(user: string): WorldState {
  try {
    const s = JSON.parse(localStorage.getItem(WORLD_KEY) ?? 'null') as WorldState | null;
    if (s && s.user === user && Number.isFinite(s.cursor) && Number.isFinite(s.pushedAt) && s.counters && typeof s.counters === 'object') {
      const counters: Record<string, Counters> = {};
      for (const [id, c] of Object.entries(s.counters)) counters[id] = maxCounters(ZERO, c);
      const retry = Array.isArray(s.retry) ? s.retry.filter((x): x is string => typeof x === 'string') : [];
      return { user: s.user, cursor: s.cursor, pushedAt: s.pushedAt, counters, ...(retry.length ? { retry } : {}) };
    }
  } catch {
    /* damaged: start again, which only re-sends */
  }
  return freshWorldState(user);
}

export function saveWorldState(s: WorldState): void {
  try {
    localStorage.setItem(WORLD_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable: the next sync sends again, which is harmless */
  }
}
