import { LEDGER_MAX, byNewest, cleanEntry, entryKey, type LedgerEntry } from './ledger';
import type { Business, DocKind } from './model';
import { cleanBusiness } from './store';

// Syncing the Receipt Maker through the person's account (docs/receipt-sync.md), shared by the website and the Android
// app: send what changed here since the last sync, take what changed elsewhere, and merge. The newer copy of a
// document wins, numbering only goes up, the newer business profile wins (the logo stays on each device).

const KEY = 'rokela.receipts.sync';
const PUSH_MAX = 200;

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
const maxCounters = (a: Counters, b: Partial<Counters>): Counters => ({
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
export async function syncReceipts(local: SyncLocal, state: SyncState, post: SyncPost, now = Date.now()): Promise<{ local: SyncLocal; state: SyncState }> {
  const waiting = local.entries.filter((e) => (e.updatedAt ?? 0) > state.pushedAt);
  const countersChanged = (Object.keys(ZERO) as DocKind[]).some((k) => local.counters[k] > state.counters[k]);
  const businessChanged = local.businessAt > state.pushedAt && !!local.business.name.trim();
  let answer: Answer | undefined;
  for (let i = 0; i < waiting.length || (i === 0 && (countersChanged || businessChanged)); i += PUSH_MAX) {
    answer = await post({
      since: state.cursor,
      entries: waiting.slice(i, i + PUSH_MAX),
      ...(i === 0 && countersChanged ? { counters: local.counters } : {}),
      ...(i === 0 && businessChanged ? { business: { data: { ...local.business, logo: undefined }, at: local.businessAt } } : {}),
    });
  }
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
  const theirs = answer.business && theirAt > local.businessAt ? cleanBusiness(answer.business) : undefined;
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
