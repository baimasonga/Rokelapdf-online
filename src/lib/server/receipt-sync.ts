import { DomainError, type Clock, type UserPrincipal } from './kernel';
import type { PgPool } from './db/pg';
import type { LicenseService } from './licenses';
import { canUsePaid } from '../licensing';
import { LEDGER_MAX, entryKey } from '../receipts/ledger';
import { cleanSynced, type SyncedEntry } from '../receipts/docs';
import { cleanBusiness } from '../receipts/store';
import type { Business, DocKind } from '../receipts/model';

// Receipt Maker sync (docs/receipt-sync.md): a person's businesses, each with its sales ledger, document numbering and
// profile, kept under their account so the website and the Android app share them. A device sends what changed since
// it last synced and gets back everything that changed since then; the newer copy of a document wins, numbering only
// goes up. A device that does not know about businesses works with the first one, 'main', as before. An entry may
// carry its full document (docs.ts), so a document made on one device can be downloaded again on another.

/** Documents a device may send in one request (keeps each request well under the API's 64 KB body limit). */
export const SYNC_PUSH_MAX = 200;
/** Documents returned in one answer; the device asks again while `more` is true. */
export const SYNC_PULL_MAX = 500;
/** Businesses one person can keep (archived ones included). */
export const BUSINESSES_MAX = 10;
/** The first business: everything synced before there were several, and all an older app version sees. */
export const MAIN_BUSINESS = 'main';
const BUSINESS_ID = /^[a-z0-9]{1,24}$/;

type Counters = Record<DocKind, number>;

export interface SyncInput {
  /** The last `cursor` this device received (0 the first time). */
  since: number;
  /** The business the entries, numbering and profile sent belong to ('main' when not given). */
  businessId?: string | undefined;
  /** Answer with every business's documents and profiles, not only the given business's. */
  all?: boolean | undefined;
  entries: unknown[];
  counters?: unknown;
  /** The business profile and when it was last edited; the logo stays on each device. */
  business?: { data: unknown; at: number } | undefined;
}

export interface SyncAnswer {
  cursor: number;
  more: boolean;
  /** Each entry with its full document when one was sent; with `all`, each also names its business. */
  entries: Array<SyncedEntry & { businessId?: string }>;
  /** The given business's numbering and profile. */
  counters: Counters;
  business: Business | null;
  businessAt: number;
  /** With `all`: every business of the person. */
  businesses?: Array<{ id: string; counters: Counters; business: Business | null; businessAt: number }>;
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
    const biz = input.businessId ?? MAIN_BUSINESS;
    if (!BUSINESS_ID.test(biz)) throw new DomainError('invalid_request', 'invalid business id');
    const entries = input.entries.map(cleanSynced).filter((e): e is SyncedEntry => !!e);
    const pushing = entries.length > 0 || input.counters !== undefined || input.business !== undefined;
    // Reading your own records always works; changing them is part of the Receipt Maker, a Pro tool.
    if (pushing && !canUsePaid(await this.#licenses.access(p), this.#clock.now())) throw new DomainError('forbidden', 'the Receipt Maker is a Pro tool');

    if (pushing) {
      // A new business takes a place among the person's businesses; there is room for BUSINESSES_MAX of them.
      const known = await this.#pool.query<{ business_id: string }>('SELECT business_id FROM receipt_sync_profiles WHERE user_id = $1', [p.userId]);
      if (!known.rows.some((r) => r.business_id === biz) && known.rows.length >= BUSINESSES_MAX)
        throw new DomainError('conflict', `you can keep at most ${BUSINESSES_MAX} businesses`);
    }

    if (entries.length) {
      const have = Number(
        (await this.#pool.query<{ n: string }>('SELECT count(*) AS n FROM receipt_sync_entries WHERE user_id = $1 AND business_id = $2', [p.userId, biz]))
          .rows[0]?.n ?? 0,
      );
      let room = LEDGER_MAX - have;
      for (const e of entries) {
        const key = entryKey(e);
        const at = e.updatedAt ?? 0;
        const r = await this.#pool.query<{ inserted: boolean }>(
          `INSERT INTO receipt_sync_entries (user_id, business_id, doc_key, entry, changed_at, seq)
           SELECT $1, $6, $2, $3::jsonb, $4, nextval('receipt_sync_seq')
           WHERE $5 OR EXISTS (SELECT 1 FROM receipt_sync_entries WHERE user_id = $1 AND business_id = $6 AND doc_key = $2)
           ON CONFLICT (user_id, business_id, doc_key) DO UPDATE SET
             -- An entry sent without its document (an older app cancelling it) keeps the document already held.
             entry = CASE WHEN EXCLUDED.entry ? 'doc' OR NOT receipt_sync_entries.entry ? 'doc' THEN EXCLUDED.entry
                          ELSE EXCLUDED.entry || jsonb_build_object('doc', receipt_sync_entries.entry->'doc') END,
             changed_at = EXCLUDED.changed_at, seq = EXCLUDED.seq
             WHERE receipt_sync_entries.changed_at < EXCLUDED.changed_at
           RETURNING (xmax = 0) AS inserted`,
          [p.userId, key, JSON.stringify(e), at, room > 0, biz],
        );
        if (r.rows[0]?.inserted) room--;
      }
    }

    // Every business that receives anything has a profile, so the person's other devices learn that it exists.
    if (pushing) {
      const sent = cleanCounters(input.counters);
      const at = input.business && Number.isFinite(input.business.at) ? Math.max(0, Math.floor(input.business.at)) : 0;
      const business = input.business ? JSON.stringify({ ...cleanBusiness(input.business.data), logo: undefined }) : null;
      // One statement, so two devices syncing at once cannot undo each other: numbering only goes up, and the business
      // profile is replaced only by a newer one (or taken as it is when the account has none yet, e.g. a profile saved
      // before sync existed, which has no edit time).
      await this.#pool.query(
        `INSERT INTO receipt_sync_profiles (user_id, business_id, counters, business, business_at, seq)
         VALUES ($1, $5, $2::jsonb, $3::jsonb, $4, nextval('receipt_sync_seq'))
         ON CONFLICT (user_id, business_id) DO UPDATE SET
           counters = jsonb_build_object(
             'receipt', GREATEST(COALESCE((receipt_sync_profiles.counters->>'receipt')::bigint, 0), (EXCLUDED.counters->>'receipt')::bigint),
             'invoice', GREATEST(COALESCE((receipt_sync_profiles.counters->>'invoice')::bigint, 0), (EXCLUDED.counters->>'invoice')::bigint),
             'proforma', GREATEST(COALESCE((receipt_sync_profiles.counters->>'proforma')::bigint, 0), (EXCLUDED.counters->>'proforma')::bigint)),
           business = CASE WHEN EXCLUDED.business IS NOT NULL
                            AND (receipt_sync_profiles.business IS NULL OR EXCLUDED.business_at > receipt_sync_profiles.business_at)
                           THEN EXCLUDED.business ELSE receipt_sync_profiles.business END,
           business_at = CASE WHEN EXCLUDED.business IS NOT NULL
                               AND (receipt_sync_profiles.business IS NULL OR EXCLUDED.business_at > receipt_sync_profiles.business_at)
                              THEN EXCLUDED.business_at ELSE receipt_sync_profiles.business_at END,
           seq = EXCLUDED.seq`,
        [p.userId, JSON.stringify(sent), business, at, biz],
      );
    }

    const since = Math.max(0, Math.floor(input.since) || 0);
    const rows = (
      await this.#pool.query<{ entry: unknown; seq: string; business_id: string }>(
        `SELECT entry, seq, business_id FROM receipt_sync_entries WHERE user_id = $1 AND seq > $2 AND ($4 OR business_id = $5)
         ORDER BY seq LIMIT $3`,
        [p.userId, since, SYNC_PULL_MAX + 1, input.all === true, biz],
      )
    ).rows;
    const more = rows.length > SYNC_PULL_MAX;
    const page = rows.slice(0, SYNC_PULL_MAX);
    const profiles = (
      await this.#pool.query<{ business_id: string; counters: unknown; business: unknown; business_at: string }>(
        'SELECT business_id, counters, business, business_at FROM receipt_sync_profiles WHERE user_id = $1 ORDER BY business_id',
        [p.userId],
      )
    ).rows.map((r) => ({
      id: r.business_id,
      counters: cleanCounters(r.counters),
      business: r.business ? cleanBusiness(r.business) : null,
      businessAt: Number(r.business_at ?? 0),
    }));
    const profile = profiles.find((x) => x.id === biz);
    const found = page.flatMap((r) => {
      const e = cleanSynced(r.entry);
      return e ? [input.all ? { ...e, businessId: r.business_id } : e] : [];
    });
    return {
      cursor: page.length ? Number(page[page.length - 1]!.seq) : since,
      more,
      entries: found,
      counters: profile?.counters ?? cleanCounters(undefined),
      business: profile?.business ?? null,
      businessAt: profile?.businessAt ?? 0,
      ...(input.all ? { businesses: profiles } : {}),
    };
  }
}
