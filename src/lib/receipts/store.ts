import { DEFAULT_BUSINESS, DEFAULT_FOOTERS, type Business, type Currency, type DocKind, type DocStyle, type PageSize } from './model';

// The business's settings for the Receipt Maker, kept in this browser only: its profile, the last number of each
// kind of document, its usual items and prices, and how it likes its documents. Nothing is uploaded.

const KEY = 'rokela.receipts.v1';

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

/** Reads the saved settings, repairing anything damaged or missing. */
export function loadPrefs(): ReceiptPrefs {
  let raw: Record<string, unknown> = {};
  try {
    raw = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>) ?? {};
  } catch {
    raw = {};
  }
  const b = (raw.business ?? {}) as Record<string, unknown>;
  const counters = (raw.counters ?? {}) as Record<string, unknown>;
  const footers = (raw.footers ?? {}) as Record<string, unknown>;
  const items: Record<string, number> = {};
  for (const [k, v] of Object.entries((raw.items ?? {}) as Record<string, unknown>).slice(0, 300))
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) items[k.slice(0, 120)] = v;
  const count = (k: DocKind) => (typeof counters[k] === 'number' && Number.isFinite(counters[k]) ? Math.max(0, Math.floor(counters[k] as number)) : 0);
  return {
    business: {
      name: str(b.name, 80),
      tagline: str(b.tagline, 120),
      address: str(b.address, 160),
      phones: str(b.phones, 80),
      email: str(b.email, 80),
      tin: str(b.tin, 30),
      color: color(b.color, DEFAULT_BUSINESS.color),
      accent: color(b.accent, DEFAULT_BUSINESS.accent),
      logo: typeof b.logo === 'string' && /^data:image\/(png|jpeg);base64,/.test(b.logo) && b.logo.length < 700_000 ? b.logo : undefined,
    },
    counters: { receipt: count('receipt'), invoice: count('invoice'), proforma: count('proforma') },
    items,
    style: raw.style === 'book' ? 'book' : 'modern',
    size: raw.size === 'A5' ? 'A5' : 'A4',
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

export function savePrefs(p: ReceiptPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private windows and full storage: settings last until the page closes.
  }
}
