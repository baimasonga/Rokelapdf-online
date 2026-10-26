// Business documents for small and medium businesses: cash receipts, sales invoices and proforma invoices
// (quotations). Plain data and arithmetic, shared by the website and tests; pdf.ts lays them out.
//
// These are the business's own documents. A business registered for GST must still issue the NRA's electronic cash
// register receipt for its sales; it can note that receipt's number on these documents.

export type DocKind = 'receipt' | 'invoice' | 'proforma';
export type DocStyle = 'book' | 'modern';
export type PageSize = 'A4' | 'A5';
export type Currency = 'NLe' | 'USD';
export type PayMethod = 'Cash' | 'Orange Money' | 'Afrimoney' | 'QMoney' | 'Bank transfer' | 'Cheque';
export const PAY_METHODS: PayMethod[] = ['Cash', 'Orange Money', 'Afrimoney', 'QMoney', 'Bank transfer', 'Cheque'];

export interface Business {
  name: string;
  tagline: string;
  address: string;
  phones: string;
  email: string;
  tin: string;
  /** Main colour (headings, tables), #rrggbb. */
  color: string;
  /** Accent colour (logo tile, balance due), #rrggbb. */
  accent: string;
  /** PNG or JPEG data URL, optional. */
  logo?: string;
}

export interface Line {
  qty: number;
  item: string;
  rate: number;
}

export interface BizDoc {
  kind: DocKind;
  style: DocStyle;
  size: PageSize;
  currency: Currency;
  number: string;
  /** yyyy-mm-dd */
  date: string;
  /** Invoice: due date. Proforma: valid until. yyyy-mm-dd or empty. */
  until: string;
  customer: string;
  customerDetails: string;
  /** Invoice: payment terms ("Credit, 30 days"). Proforma: the client's reference. */
  reference: string;
  lines: Line[];
  discount: number;
  delivery: number;
  /** Adds a GST line at 15% (GST-registered businesses' invoices and quotations). */
  gst: boolean;
  /** Receipt: always the total. Invoice: what has been paid so far. */
  paid: number;
  method: PayMethod;
  /** Payer's number and transaction ID for mobile money, or the bank/cheque reference. */
  payRef: string;
  /** Invoice: how to pay. Proforma: terms. */
  notes: string;
  /** The business's own closing line(s). */
  footer: string;
  /** Receipt book style: the counterfoil strip down the side. */
  counterfoil: boolean;
  /** A second page marked OFFICE COPY. */
  officeCopy: boolean;
  /** Signature picture (PNG data URL) and the name under it. */
  signature?: string;
  signedBy: string;
  /** Stamp picture (PNG data URL from the Stamp Studio), and a PAID stamp when paid in full. */
  stamp?: string;
  paidStamp?: string;
}

export const GST_RATE = 0.15;
export const DEFAULT_BUSINESS: Business = {
  name: '',
  tagline: '',
  address: '',
  phones: '',
  email: '',
  tin: '',
  color: '#12306b',
  accent: '#e2483d',
};
export const TITLES: Record<DocKind, Record<DocStyle, string>> = {
  receipt: { book: 'CASH SALES RECEIPT', modern: 'Receipt' },
  invoice: { book: 'SALES INVOICE', modern: 'Invoice' },
  proforma: { book: 'PROFORMA INVOICE', modern: 'Proforma invoice' },
};
export const DEFAULT_FOOTERS: Record<DocKind, string> = {
  receipt: 'Goods sold are not returnable · Thank you for your patronage',
  invoice: 'Goods remain our property until paid in full · Thank you for your patronage',
  proforma: 'This is a quotation, not a request for payment.',
};
const PREFIX: Record<DocKind, string> = { receipt: '', invoice: 'INV-', proforma: 'PF-' };

/** "0457", "INV-0213", "PF-0089" for the n-th document of a kind. */
export function docNumber(kind: DocKind, n: number): string {
  return `${PREFIX[kind]}${String(Math.max(1, Math.floor(n))).padStart(4, '0')}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
export interface Totals {
  subtotal: number;
  discount: number;
  delivery: number;
  gst: number;
  total: number;
  paid: number;
  balance: number;
}
export function totals(d: Pick<BizDoc, 'kind' | 'lines' | 'discount' | 'delivery' | 'gst' | 'paid'>): Totals {
  const subtotal = round2(d.lines.reduce((s, l) => s + (Number.isFinite(l.qty * l.rate) ? l.qty * l.rate : 0), 0));
  const discount = round2(Math.min(Math.max(0, d.discount || 0), subtotal));
  const delivery = round2(Math.max(0, d.delivery || 0));
  const taxable = subtotal - discount + delivery;
  const gst = d.gst ? round2(taxable * GST_RATE) : 0;
  const total = round2(taxable + gst);
  const paid = d.kind === 'receipt' ? total : d.kind === 'proforma' ? 0 : round2(Math.min(Math.max(0, d.paid || 0), total));
  return { subtotal, discount, delivery, gst, total, paid, balance: round2(total - paid) };
}

/** 1234.5 → "1,234.50" */
export const money = (n: number) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- amount in words ----------------------------------------------------------------------------------------
const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under1000(n: number, joinAnd: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const tens = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? '-' + ONES[r % 10] : ''}`;
  if (!h) return (joinAnd && r ? 'and ' : '') + tens;
  return `${ONES[h]} Hundred${r ? ` and ${tens}` : ''}`;
}
/** 20970 → "Twenty Thousand Nine Hundred and Seventy" (British usage). */
export function numberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const units: Array<[number, string]> = [
    [1e12, 'Trillion'],
    [1e9, 'Billion'],
    [1e6, 'Million'],
    [1e3, 'Thousand'],
    [1, ''],
  ];
  const out: string[] = [];
  for (const [u, name] of units) {
    const q = Math.floor(n / u) % 1000;
    // "One Thousand and Five": the last group takes "and" when it is under a hundred and something came before.
    if (q) out.push(`${under1000(q, u === 1 && out.length > 0)}${name ? ' ' + name : ''}`);
  }
  return out.join(' ');
}
const CURRENCY_WORDS: Record<Currency, [string, string, string, string]> = {
  NLe: ['New Leone', 'New Leones', 'Cent', 'Cents'],
  USD: ['US Dollar', 'US Dollars', 'Cent', 'Cents'],
};
/** 2500.5 → "Two Thousand Five Hundred New Leones and Fifty Cents Only" */
export function amountInWords(amount: number, currency: Currency = 'NLe'): string {
  const whole = Math.floor(Math.round(Math.abs(amount) * 100) / 100);
  const cents = Math.round((Math.abs(amount) - whole) * 100);
  const [one, many, cent, cents_] = CURRENCY_WORDS[currency];
  const main = `${numberWords(whole)} ${whole === 1 ? one : many}`;
  return `${main}${cents ? ` and ${numberWords(cents)} ${cents === 1 ? cent : cents_}` : ''} Only`;
}

/** "26 October 2026" for a yyyy-mm-dd date (as written on documents); empty for an empty date. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
