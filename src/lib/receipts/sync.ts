import { LEDGER_MAX, byNewest, cleanEntry, entryKey, type LedgerEntry } from './ledger';
import type { Business, DocKind } from './model';
import { cleanBusiness } from './store';

// Syncing the Receipt Maker through the person's account (docs/receipt-sync.md), shared by the website and the Android
// app: send what changed here since the last sync, take what changed elsewhere, and merge. The newer copy of a
// document wins, numbering only goes up, the newer business profile wins (the logo stays on each device).

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
