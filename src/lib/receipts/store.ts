import { DEFAULT_BUSINESS, DEFAULT_FOOTERS, docNumber, type BizDoc, type Business, type Currency, type DocKind, type DocStyle, type PageSize } from './model';

// Each business's settings for the Receipt Maker, kept on this device: its profile, the last number of each kind of
// document, its usual items and prices, and how it likes its documents. Signed in, the profile and numbering also sync
// through the account (sync.ts); the rest stays here.

const KEY = 'rokela.receipts.v1';
/** Each business keeps its own settings; the first one ('main') keeps the key used before there were several. */
const keyOf = (business: string) => (business === 'main' ? KEY : `${KEY}:${business}`);

export interface ReceiptPrefs {
  business: Business;
  /** Last number used, per kind of document. */
  counters: Record<DocKind, number>;
  /** Usual items and their last price ("Cement, 50 kg bag" → 155). */
  items: Record<string, number>;
  style: DocStyle;
  size: PageSize;
  currency: Currency;
  footers: Record<DocKind, string>;
  signedBy: string;
  /** The Stamp Studio stamp put on documents ('' for none). */
  stampId: string;
  /** Adds a PAID stamp to settled receipts and invoices. */
  paidStamp: boolean;
  /** Prints a QR code anyone can scan to check the document (docs/receipt-checks.md); needs an account. */
  check: boolean;
  /** When the business profile was last edited (ms since 1970), so syncing keeps the latest one. */
  businessAt?: number;
  /** The signature put on documents (PNG data URL), made on this device. */
  signature?: string;
}

export const DEFAULT_PREFS: ReceiptPrefs = {
  business: DEFAULT_BUSINESS,
  counters: { receipt: 0, invoice: 0, proforma: 0 },
  items: {},
  style: 'modern',
  size: 'A4',
  currency: 'NLe',
  footers: DEFAULT_FOOTERS,
  signedBy: '',
  stampId: '',
  paidStamp: true,
  check: false,
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const color = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);

/** A business profile from storage or another device, repaired where damaged. Also used by the server. */
export function cleanBusiness(raw: unknown): Business {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    name: str(b.name, 80),
    tagline: str(b.tagline, 120),
    address: str(b.address, 160),
    phones: str(b.phones, 80),
    email: str(b.email, 80),
    tin: str(b.tin, 30),
    color: color(b.color, DEFAULT_BUSINESS.color),
    accent: color(b.accent, DEFAULT_BUSINESS.accent),
    logo: typeof b.logo === 'string' && /^data:image\/(png|jpeg);base64,/.test(b.logo) && b.logo.length < 700_000 ? b.logo : undefined,
    ...(b.archived === true ? { archived: true } : {}),
  };
}

/** Reads a business's saved settings, repairing anything damaged or missing. */
export function loadPrefs(business = 'main'): ReceiptPrefs {
  let raw: Record<string, unknown> = {};
  try {
    raw = (JSON.parse(localStorage.getItem(keyOf(business)) ?? '{}') as Record<string, unknown>) ?? {};
  } catch {
    raw = {};
  }
  const counters = (raw.counters ?? {}) as Record<string, unknown>;
  const footers = (raw.footers ?? {}) as Record<string, unknown>;
  const items: Record<string, number> = {};
  for (const [k, v] of Object.entries((raw.items ?? {}) as Record<string, unknown>).slice(0, 300))
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) items[k.slice(0, 120)] = v;
  const count = (k: DocKind) => (typeof counters[k] === 'number' && Number.isFinite(counters[k]) ? Math.max(0, Math.floor(counters[k] as number)) : 0);
  return {
    business: cleanBusiness(raw.business),
    ...(typeof raw.businessAt === 'number' && Number.isFinite(raw.businessAt) ? { businessAt: raw.businessAt } : {}),
    counters: { receipt: count('receipt'), invoice: count('invoice'), proforma: count('proforma') },
    items,
    style: raw.style === 'book' ? 'book' : 'modern',
    size: raw.size === 'A5' || raw.size === '80mm' || raw.size === '58mm' ? raw.size : 'A4',
    currency: raw.currency === 'USD' ? 'USD' : 'NLe',
    footers: {
      receipt: typeof footers.receipt === 'string' ? footers.receipt.slice(0, 200) : DEFAULT_FOOTERS.receipt,
      invoice: typeof footers.invoice === 'string' ? footers.invoice.slice(0, 200) : DEFAULT_FOOTERS.invoice,
      proforma: typeof footers.proforma === 'string' ? footers.proforma.slice(0, 200) : DEFAULT_FOOTERS.proforma,
    },
    signedBy: str(raw.signedBy, 60),
    stampId: str(raw.stampId, 40),
    paidStamp: raw.paidStamp !== false,
    check: raw.check === true,
    signature:
      typeof raw.signature === 'string' && /^data:image\/png;base64,/.test(raw.signature) && raw.signature.length < 400_000 ? raw.signature : undefined,
  };
}

export function savePrefs(p: ReceiptPrefs, business = 'main'): void {
  try {
    localStorage.setItem(keyOf(business), JSON.stringify(p));
  } catch {
    // Private windows and full storage: settings last until the page closes.
  }
}

// ---- documents from the settings (shared by the website and the Android app) ------------------------------------
/** A local date as yyyy-mm-dd. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => isoDate(new Date(Date.now() + n * 86_400_000));
/** The running number at the end of a document number ("INV-0213" → 213). */
export const numberOf = (s: string) => Number(/(\d+)\D*$/.exec(s)?.[1] ?? 0);

/** A new, empty document of this kind with the next number and the business's usual choices. */
export function newDoc(kind: DocKind, p: ReceiptPrefs): BizDoc {
  return {
    kind,
    style: p.style,
    size: p.size,
    currency: p.currency,
    number: docNumber(kind, p.counters[kind] + 1),
    date: isoDate(new Date()),
    until: kind === 'invoice' ? inDays(30) : kind === 'proforma' ? inDays(14) : '',
    customer: '',
    customerDetails: '',
    reference: kind === 'invoice' ? 'Credit, 30 days' : '',
    lines: [{ qty: 1, item: '', rate: 0 }],
    discount: 0,
    delivery: 0,
    gst: false,
    paid: 0,
    method: 'Cash',
    payRef: '',
    notes: '',
    footer: p.footers[kind],
    counterfoil: true,
    officeCopy: false,
    signedBy: p.signedBy,
  };
}

/** The settings after a document is made: its number is used, its prices and footer remembered. */
export function afterDoc(p: ReceiptPrefs, doc: BizDoc): ReceiptPrefs {
  const items = { ...p.items };
  for (const l of doc.lines) if (l.item.trim() && l.rate > 0) items[l.item.trim().slice(0, 120)] = l.rate;
  return {
    ...p,
    counters: { ...p.counters, [doc.kind]: Math.max(p.counters[doc.kind], numberOf(doc.number)) },
    items: Object.fromEntries(Object.entries(items).slice(-300)),
    footers: { ...p.footers, [doc.kind]: doc.footer },
    signedBy: doc.signedBy,
  };
}

/** Shrinks a chosen logo so it stays small in saved settings and in every document (browser only). */
export async function logoDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 320 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
