import { cleanEntry, entryKey, type LedgerEntry } from './ledger';
import { PAY_METHODS, type BizDoc, type DocKind, type Line, type PayMethod } from './model';
import { newDoc, type ReceiptPrefs } from './store';

// Every receipt, invoice and quotation made, kept in full (not only the ledger's summary), so it can be found again,
// downloaded again, or copied into a new document. Kept on the device in IndexedDB (thousands of documents do not fit
// the few megabytes of localStorage), per business, and synced with the ledger entry it belongs to (sync.ts).
// Pictures are not kept: the signature, stamp and PAID stamp are added again from the business's settings when the
// document is made again; the stamp chosen at the time is remembered by its Stamp Studio id.

/** A document as made, without its pictures. */
export type SavedDoc = Omit<BizDoc, 'signature' | 'stamp' | 'paidStamp'> & {
  /** The Stamp Studio stamp it carried, if any. */
  stampId?: string;
  /** When it was made (ms since 1970). */
  savedAt: number;
};

export function toSaved(doc: BizDoc, stampId: string | undefined, now = Date.now()): SavedDoc {
  const rest: Partial<BizDoc> = { ...doc };
  delete rest.signature;
  delete rest.stamp;
  delete rest.paidStamp;
  return { ...(rest as BizDoc), ...(stampId ? { stampId } : {}), savedAt: now };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 1e12) : 0);

/**
 * A saved document from storage, another device or the API, repaired where damaged (undefined when it is not one).
 * Also used by the server. The API sends keys in snake_case (customer_details, saved_at); devices use camelCase.
 */
export function cleanSaved(raw: unknown): SavedDoc | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string) => r[camel] ?? r[snake];
  const kind = r.kind === 'receipt' || r.kind === 'invoice' || r.kind === 'proforma' ? (r.kind as DocKind) : undefined;
  const number = str(r.number, 40).trim();
  const date = str(r.date, 10);
  if (!kind || !number || !ISO.test(date)) return undefined;
  const lines: Line[] = (Array.isArray(r.lines) ? r.lines : [])
    .slice(0, 60)
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map((l) => ({ qty: amount(l.qty), item: str(l.item, 120), rate: amount(l.rate) }));
  const method = PAY_METHODS.includes(r.method as PayMethod) ? (r.method as PayMethod) : 'Cash';
  const check = r.check && typeof r.check === 'object' ? (r.check as Record<string, unknown>) : undefined;
  const checkUrl = str(check?.url, 200);
  const checkCode = str(check?.code, 40);
  const savedAt = pick('savedAt', 'saved_at');
  const stampId = str(pick('stampId', 'stamp_id'), 40);
  const against = str(r.against, 40).trim();
  return {
    kind,
    style: r.style === 'book' ? 'book' : 'modern',
    size: r.size === 'A5' || r.size === '80mm' || r.size === '58mm' ? r.size : 'A4',
    currency: r.currency === 'USD' ? 'USD' : 'NLe',
    number,
    date,
    until: ISO.test(str(r.until, 10)) ? str(r.until, 10) : '',
    customer: str(r.customer, 100),
    customerDetails: str(pick('customerDetails', 'customer_details'), 160),
    reference: str(r.reference, 80),
    lines: lines.length ? lines : [{ qty: 1, item: '', rate: 0 }],
    discount: amount(r.discount),
    delivery: amount(r.delivery),
    gst: r.gst === true,
    paid: amount(r.paid),
    method,
    payRef: str(pick('payRef', 'pay_ref'), 80),
    notes: str(r.notes, 500),
    footer: str(r.footer, 200),
    counterfoil: r.counterfoil !== false,
    officeCopy: pick('officeCopy', 'office_copy') === true,
    signedBy: str(pick('signedBy', 'signed_by'), 60),
    ...(against ? { against } : {}),
    ...(/^https?:\/\//.test(checkUrl) && checkCode ? { check: { url: checkUrl, code: checkCode } } : {}),
    ...(stampId ? { stampId } : {}),
    savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt) : 0,
  };
}

/** A new document with the same customer, items and terms as a saved one, and this business's next number and today. */
export function copyAsNew(saved: SavedDoc, prefs: ReceiptPrefs): BizDoc {
  const fresh = newDoc(saved.kind, prefs);
  return {
    ...fresh,
    style: saved.style,
    size: saved.size,
    currency: saved.currency,
    customer: saved.customer,
    customerDetails: saved.customerDetails,
    reference: saved.reference,
    lines: saved.lines.map((l) => ({ ...l })),
    discount: saved.discount,
    delivery: saved.delivery,
    gst: saved.gst,
    method: saved.method,
    notes: saved.notes,
    footer: saved.footer,
    counterfoil: saved.counterfoil,
    officeCopy: saved.officeCopy,
  };
}

/** A ledger entry as synced: the entry, and the full document when the device that made it kept one. */
export type SyncedEntry = LedgerEntry & { doc?: SavedDoc };

/** An entry from another device or the API, with its document if it carries one for the same kind and number. */
export function cleanSynced(raw: unknown): SyncedEntry | undefined {
  const e = cleanEntry(raw);
  if (!e) return undefined;
  const doc = cleanSaved((raw as Record<string, unknown>).doc);
  return doc && docKey(doc) === entryKey(e) ? { ...e, doc } : e;
}

// ---- storage on the device --------------------------------------------------------------------------------------

/** Where a device keeps its saved documents, per business, by the ledger's key ("invoice inv-0001"). */
export interface DocStore {
  get(business: string, key: string): Promise<SavedDoc | undefined>;
  put(business: string, doc: SavedDoc): Promise<void>;
  /** The keys of every saved document of a business. */
  keys(business: string): Promise<Set<string>>;
}

export const docKey = (d: Pick<SavedDoc, 'kind' | 'number'>) => entryKey(d);

/** In memory only: for tests, and where IndexedDB is unavailable (documents last until the page closes). */
export function memoryDocs(): DocStore {
  const all = new Map<string, Map<string, SavedDoc>>();
  const of = (b: string) => all.get(b) ?? all.set(b, new Map()).get(b)!;
  return {
    async get(b, key) {
      return of(b).get(key);
    },
    async put(b, doc) {
      of(b).set(docKey(doc), doc);
    },
    async keys(b) {
      return new Set(of(b).keys());
    },
  };
}

const DB = 'rokela-receipts';
const STORE = 'docs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ['business', 'key'] }).createIndex('business', 'business');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDocs(): DocStore {
  let db: Promise<IDBDatabase> | undefined;
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    (db ??= openDb()).then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
        }),
    );
  return {
    async get(b, key) {
      const row = await run<{ doc: unknown } | undefined>('readonly', (s) => s.get([b, key]));
      return row ? cleanSaved(row.doc) : undefined;
    },
    async put(b, doc) {
      await run('readwrite', (s) => s.put({ business: b, key: docKey(doc), doc }));
    },
    async keys(b) {
      const rows = await run<IDBValidKey[]>('readonly', (s) => s.index('business').getAllKeys(b));
      return new Set(rows.map((k) => String((k as [string, string])[1])));
    },
  };
}

let shared: DocStore | undefined;
/** This device's saved documents: IndexedDB, or memory when the browser has none (private windows in some browsers). */
export function deviceDocs(): DocStore {
  if (shared) return shared;
  const fallback = memoryDocs();
  if (typeof indexedDB === 'undefined') return (shared = fallback);
  const idb = idbDocs();
  let broken = false;
  const safe =
    <A extends unknown[], T>(fn: (...a: A) => Promise<T>, alt: (...a: A) => Promise<T>) =>
    async (...a: A): Promise<T> => {
      if (broken) return alt(...a);
      try {
        return await fn(...a);
      } catch {
        broken = true;
        return alt(...a);
      }
    };
  return (shared = { get: safe(idb.get, fallback.get), put: safe(idb.put, fallback.put), keys: safe(idb.keys, fallback.keys) });
}
