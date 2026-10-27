import { DomainError, type Clock, type UserPrincipal } from './kernel';
import type { PgPool } from './db/pg';
import type { LicenseService } from './licenses';
import { canUsePaid } from '../licensing';
import { LEDGER_MAX, cleanEntry, entryKey, type LedgerEntry } from '../receipts/ledger';
import { cleanBusiness } from '../receipts/store';
import type { Business, DocKind } from '../receipts/model';

// Receipt Maker sync (docs/receipt-sync.md): a person's sales ledger, document numbering and business profile, kept
// under their account so the website and the Android app share them. A device sends what changed since it last synced
// and gets back everything that changed since then; the newer copy of a document wins, numbering only goes up.

/** Documents a device may send in one request (keeps each request well under the API's 64 KB body limit). */
export const SYNC_PUSH_MAX = 200;
/** Documents returned in one answer; the device asks again while `more` is true. */
export const SYNC_PULL_MAX = 500;

type Counters = Record<DocKind, number>;
const KINDS: DocKind[] = ['receipt', 'invoice', 'proforma'];

export interface SyncInput {
  /** The last `cursor` this device received (0 the first time). */
  since: number;
  entries: unknown[];
  counters?: unknown;
  /** The business profile and when it was last edited; the logo stays on each device. */
  business?: { data: unknown; at: number } | undefined;
}

export interface SyncAnswer {
  cursor: number;
  more: boolean;
  entries: LedgerEntry[];
  counters: Counters;
  business: Business | null;
  businessAt: number;
}

function cleanCounters(raw: unknown): Counters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(99_999_999, Math.max(0, Math.floor(v))) : 0);
  return { receipt: n(r.receipt), invoice: n(r.invoice), proforma: n(r.proforma) };
}

export class ReceiptSyncService {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  readonly #licenses: LicenseService;

  constructor(pool: PgPool, clock: Clock, licenses: LicenseService) {
    this.#pool = pool;
    this.#clock = clock;
    this.#licenses = licenses;
  }

  async sync(p: UserPrincipal, input: SyncInput): Promise<SyncAnswer> {
    if (!p.emailVerified) throw new DomainError('forbidden', 'confirm your email address first');
    if (input.entries.length > SYNC_PUSH_MAX) throw new DomainError('invalid_request', `send at most ${SYNC_PUSH_MAX} documents at a time`);
    const entries = input.entries.map(cleanEntry).filter((e): e is LedgerEntry => !!e);
    const pushing = entries.length > 0 || input.counters !== undefined || input.business !== undefined;
    // Reading your own records always works; changing them is part of the Receipt Maker, a Pro tool.
    if (pushing && !canUsePaid(await this.#licenses.access(p), this.#clock.now())) throw new DomainError('forbidden', 'the Receipt Maker is a Pro tool');

    if (entries.length) {
      const have = Number(
        (await this.#pool.query<{ n: string }>('SELECT count(*) AS n FROM receipt_sync_entries WHERE user_id = $1', [p.userId])).rows[0]?.n ?? 0,
      );
      let room = LEDGER_MAX - have;
      for (const e of entries) {
        const key = entryKey(e);
        const at = e.updatedAt ?? 0;
        const r = await this.#pool.query<{ inserted: boolean }>(
          `INSERT INTO receipt_sync_entries (user_id, doc_key, entry, changed_at, seq)
           SELECT $1, $2, $3::jsonb, $4, nextval('receipt_sync_seq')
           WHERE $5 OR EXISTS (SELECT 1 FROM receipt_sync_entries WHERE user_id = $1 AND doc_key = $2)
           ON CONFLICT (user_id, doc_key) DO UPDATE SET entry = EXCLUDED.entry, changed_at = EXCLUDED.changed_at, seq = EXCLUDED.seq
             WHERE receipt_sync_entries.changed_at < EXCLUDED.changed_at
           RETURNING (xmax = 0) AS inserted`,
          [p.userId, key, JSON.stringify(e), at, room > 0],
        );
        if (r.rows[0]?.inserted) room--;
      }
    }

    if (input.counters !== undefined || input.business !== undefined) {
      const old = (
        await this.#pool.query<{ counters: unknown; business: unknown; business_at: string }>(
          'SELECT counters, business, business_at FROM receipt_sync_profiles WHERE user_id = $1',
          [p.userId],
        )
      ).rows[0];
      const was = cleanCounters(old?.counters);
      const sent = cleanCounters(input.counters);
      // Numbering only goes up, so two devices never hand out the same number twice.
      const counters = Object.fromEntries(KINDS.map((k) => [k, Math.max(was[k], sent[k])])) as Counters;
      const wasAt = Number(old?.business_at ?? 0);
      const at = input.business && Number.isFinite(input.business.at) ? Math.max(0, Math.floor(input.business.at)) : 0;
      const newer = !!input.business && at > wasAt;
      const business = newer ? { ...cleanBusiness(input.business!.data), logo: undefined } : (old?.business ?? null);
      const changed = !old || newer || KINDS.some((k) => counters[k] !== was[k]);
      if (changed)
        await this.#pool.query(
          `INSERT INTO receipt_sync_profiles (user_id, counters, business, business_at, seq) VALUES ($1, $2::jsonb, $3::jsonb, $4, nextval('receipt_sync_seq'))
           ON CONFLICT (user_id) DO UPDATE SET counters = EXCLUDED.counters, business = EXCLUDED.business, business_at = EXCLUDED.business_at, seq = EXCLUDED.seq`,
          [p.userId, JSON.stringify(counters), business === null ? null : JSON.stringify(business), newer ? at : wasAt],
        );
    }

    const since = Math.max(0, Math.floor(input.since) || 0);
    const rows = (
      await this.#pool.query<{ entry: unknown; seq: string }>(
        'SELECT entry, seq FROM receipt_sync_entries WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
        [p.userId, since, SYNC_PULL_MAX + 1],
      )
    ).rows;
    const more = rows.length > SYNC_PULL_MAX;
    const page = rows.slice(0, SYNC_PULL_MAX);
    const profile = (
      await this.#pool.query<{ counters: unknown; business: unknown; business_at: string }>(
        'SELECT counters, business, business_at FROM receipt_sync_profiles WHERE user_id = $1',
        [p.userId],
      )
    ).rows[0];
    return {
      cursor: page.length ? Number(page[page.length - 1]!.seq) : since,
      more,
      entries: page.map((r) => cleanEntry(r.entry)).filter((e): e is LedgerEntry => !!e),
      counters: cleanCounters(profile?.counters),
      business: profile?.business ? cleanBusiness(profile.business) : null,
      businessAt: Number(profile?.business_at ?? 0),
    };
  }
}
