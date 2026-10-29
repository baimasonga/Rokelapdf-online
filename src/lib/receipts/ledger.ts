import { shortDate, totals, type BizDoc, type Currency, type DocKind } from './model';

// The sales ledger: every receipt, invoice and quotation a business makes in the Receipt Maker, kept on this device.
// It answers "who owes me what" and produces customer statements. Plain data and arithmetic, tested without a browser.
//
// Accounting, kept simple for small businesses:
// - an invoice charges the customer its total; anything paid when it was made is a payment on the same day;
// - a receipt made "against" an invoice is a payment on that invoice;
// - any other receipt is a cash sale: a sale, but nothing on the customer's account;
// - a quotation (proforma) is listed but never charged.

const KEY = 'rokela.ledger.v1';
/** Each business has its own ledger; the first one ('main') keeps the key used before there were several. */
const keyOf = (business: string) => (business === 'main' ? KEY : `${KEY}:${business}`);
export const LEDGER_MAX = 5000;
const DAY_MS = 86_400_000;

export interface LedgerEntry {
  kind: DocKind;
  number: string;
  /** yyyy-mm-dd */
  date: string;
  /** Invoice due date or quotation expiry (yyyy-mm-dd, or ''). */
  due: string;
  customer: string;
  currency: Currency;
  total: number;
  /** Invoice: paid when it was made. */
  paidAtIssue: number;
  /** Receipt: the invoice number it pays, if any. */
  against?: string;
  method?: string;
  /** Cancelled by the business: kept for the record, left out of every sum. */
  void?: boolean;
  /** When this entry last changed (ms since 1970), so syncing across devices keeps the latest version. */
  updatedAt?: number;
}

export type InvoiceStatus = 'paid' | 'part' | 'unpaid' | 'overdue';

const round2 = (n: number) => Math.round(n * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Customers match regardless of case and spacing ("Sunrise Ltd" = "sunrise  ltd"). */
export const customerKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const sameDoc = (a: Pick<LedgerEntry, 'kind' | 'number'>, b: Pick<LedgerEntry, 'kind' | 'number'>) =>
  a.kind === b.kind && a.number.trim().toLowerCase() === b.number.trim().toLowerCase();
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export function entryFromDoc(doc: BizDoc): LedgerEntry {
  const sum = totals(doc);
  return {
    kind: doc.kind,
    number: doc.number.trim(),
    date: doc.date,
    due: doc.kind === 'receipt' ? '' : doc.until,
    customer: doc.customer.trim(),
    currency: doc.currency,
    total: sum.total,
    paidAtIssue: doc.kind === 'invoice' ? sum.paid : 0,
    ...(doc.kind === 'receipt' && doc.against ? { against: doc.against } : {}),
    ...(doc.kind !== 'proforma' ? { method: doc.method } : {}),
    updatedAt: Date.now(),
  };
}

/** Adds a document, replacing an earlier save of the same document (same kind and number). Newest first. */
export function upsert(entries: LedgerEntry[], e: LedgerEntry): LedgerEntry[] {
  return [e, ...entries.filter((x) => !sameDoc(x, e))].slice(0, LEDGER_MAX);
}

export function setVoid(entries: LedgerEntry[], e: Pick<LedgerEntry, 'kind' | 'number'>, value: boolean): LedgerEntry[] {
  return entries.map((x) => (sameDoc(x, e) ? { ...x, void: value, updatedAt: Date.now() } : x));
}

const live = (entries: LedgerEntry[]) => entries.filter((e) => !e.void);
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/** How a customer's name is shown: the spelling used most often (the earliest, on a tie). */
function displayName(entries: LedgerEntry[], key: string): string {
  const counts = new Map<string, { n: number; first: string }>();
  for (const e of entries) {
    if (customerKey(e.customer) !== key) continue;
    const name = tidy(e.customer);
    const c = counts.get(name) ?? { n: 0, first: e.date };
    c.n++;
    if (e.date < c.first) c.first = e.date;
    counts.set(name, c);
  }
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first.localeCompare(b[1].first))[0]?.[0] ?? key;
}

/** Payments on an invoice: what was paid when it was made, plus the receipts made against it. */
export function invoicePaid(entries: LedgerEntry[], inv: LedgerEntry): number {
  const receipts = live(entries).filter((r) => r.kind === 'receipt' && r.against && r.against.trim().toLowerCase() === inv.number.toLowerCase());
  return round2(inv.paidAtIssue + receipts.reduce((s, r) => s + r.total, 0));
}

export function invoiceState(entries: LedgerEntry[], inv: LedgerEntry, today: string): { paid: number; balance: number; status: InvoiceStatus } {
  const paid = invoicePaid(entries, inv);
  const balance = round2(Math.max(0, inv.total - paid));
  const status: InvoiceStatus = balance <= 0 ? 'paid' : inv.due && ISO.test(inv.due) && inv.due < today ? 'overdue' : paid > 0 ? 'part' : 'unpaid';
  return { paid, balance, status };
}

/** Invoices with something still to pay, oldest first. */
export function openInvoices(entries: LedgerEntry[], today: string, customer?: string) {
  const key = customer === undefined ? undefined : customerKey(customer);
  return live(entries)
    .filter((e) => e.kind === 'invoice' && (key === undefined || customerKey(e.customer) === key))
    .map((inv) => ({ inv, ...invoiceState(entries, inv, today) }))
    .filter((x) => x.balance > 0)
    .sort((a, b) => a.inv.date.localeCompare(b.inv.date));
}

export interface Summary {
  /** Cash sales and invoices dated in the period. */
  sales: number;
  /** Money in during the period: cash sales, payments at invoicing and receipts against invoices. */
  received: number;
  /** Still owed on all invoices, and the part of it that is past due. */
  outstanding: number;
  overdue: number;
  documents: number;
}

/** Totals in one currency for the dates from..to (inclusive), with what is owed as of `today`. */
export function summary(entries: LedgerEntry[], currency: Currency, from: string, to: string, today: string): Summary {
  const inCur = live(entries).filter((e) => e.currency === currency);
  const inPeriod = inCur.filter((e) => e.date >= from && e.date <= to);
  const sales = inPeriod.filter((e) => e.kind === 'invoice' || (e.kind === 'receipt' && !e.against)).reduce((s, e) => s + e.total, 0);
  const received = inPeriod.reduce((s, e) => s + (e.kind === 'receipt' ? e.total : e.kind === 'invoice' ? e.paidAtIssue : 0), 0);
  let outstanding = 0;
  let overdue = 0;
  for (const x of openInvoices(inCur, today)) {
    outstanding += x.balance;
    if (x.status === 'overdue') overdue += x.balance;
  }
  return { sales: round2(sales), received: round2(received), outstanding: round2(outstanding), overdue: round2(overdue), documents: inPeriod.length };
}

/** Customers with invoices in this currency, those who owe most first. */
export function customers(entries: LedgerEntry[], currency: Currency, today: string) {
  const byKey = new Map<string, { name: string; owed: number; overdue: number; invoices: number; last: string }>();
  for (const e of live(entries)) {
    if (e.currency !== currency || !e.customer || (e.kind !== 'invoice' && !(e.kind === 'receipt' && e.against))) continue;
    const k = customerKey(e.customer);
    const c = byKey.get(k) ?? { name: e.customer, owed: 0, overdue: 0, invoices: 0, last: '' };
    if (e.date > c.last) c.last = e.date;
    if (e.kind === 'invoice') {
      c.invoices++;
      const s = invoiceState(entries, e, today);
      c.owed = round2(c.owed + s.balance);
      if (s.status === 'overdue') c.overdue = round2(c.overdue + s.balance);
    }
    byKey.set(k, c);
  }
  for (const [k, c] of byKey) c.name = displayName(entries, k);
  return [...byKey.values()].filter((c) => c.invoices > 0).sort((a, b) => b.owed - a.owed || b.last.localeCompare(a.last));
}

export interface StatementRow {
  date: string;
  ref: string;
  details: string;
  charge: number;
  payment: number;
  balance: number;
}
export interface Statement {
  customer: string;
  currency: Currency;
  from: string;
  to: string;
  opening: number;
  rows: StatementRow[];
  closing: number;
  /** What is still owed on invoices, by how long past their due date: current, 1–30, 31–60, 61–90, over 90 days. */
  ageing: [number, number, number, number, number];
}

/** A customer's account for the dates from..to: opening balance, each charge and payment, and the closing balance. */
export function statement(entries: LedgerEntry[], customer: string, currency: Currency, from: string, to: string): Statement {
  const key = customerKey(customer);
  const mine = live(entries).filter((e) => e.currency === currency && customerKey(e.customer) === key);
  // Every movement on the account, in date order (charges before payments on the same day).
  const moves: Array<Omit<StatementRow, 'balance'>> = [];
  for (const e of mine) {
    if (e.kind === 'invoice') {
      moves.push({ date: e.date, ref: e.number, details: e.due ? `Invoice, due ${shortDate(e.due)}` : 'Invoice', charge: e.total, payment: 0 });
      if (e.paidAtIssue > 0) moves.push({ date: e.date, ref: e.number, details: 'Paid when invoiced', charge: 0, payment: e.paidAtIssue });
    } else if (e.kind === 'receipt' && e.against)
      moves.push({ date: e.date, ref: e.number, details: `Payment for ${e.against}${e.method ? ` (${e.method})` : ''}`, charge: 0, payment: e.total });
  }
  moves.sort((a, b) => a.date.localeCompare(b.date) || b.charge - a.charge || a.ref.localeCompare(b.ref));
  let balance = 0;
  for (const m of moves) if (m.date < from) balance += m.charge - m.payment;
  const opening = round2(balance);
  const rows: StatementRow[] = [];
  for (const m of moves) {
    if (m.date < from || m.date > to) continue;
    balance += m.charge - m.payment;
    rows.push({ ...m, balance: round2(balance) });
  }
  // Ageing of what each invoice dated up to `to` still owes, measured at `to`.
  const ageing: Statement['ageing'] = [0, 0, 0, 0, 0];
  for (const inv of mine.filter((e) => e.kind === 'invoice' && e.date <= to)) {
    const paid = round2(
      inv.paidAtIssue +
        mine
          .filter((r) => r.kind === 'receipt' && r.date <= to && r.against?.trim().toLowerCase() === inv.number.toLowerCase())
          .reduce((s, r) => s + r.total, 0),
    );
    const owed = round2(inv.total - paid);
    if (owed <= 0) continue;
    const late = days(ISO.test(inv.due) ? inv.due : inv.date, to);
    const bucket = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    ageing[bucket] = round2(ageing[bucket] + owed);
  }
  return { customer: mine.length ? displayName(mine, key) : tidy(customer), currency, from, to, opening, rows, closing: round2(balance), ageing };
}

/** Comma-separated values for a spreadsheet: one row per document, with each invoice's balance. */
export function ledgerCsv(entries: LedgerEntry[], today: string): string {
  const q = (v: string | number) => {
    const s = String(v);
    // Leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) && typeof v === 'string' ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ['Date', 'Type', 'Number', 'Customer', 'Currency', 'Total', 'Paid', 'Balance', 'Status', 'For invoice', 'Method'];
  const rows = entries.map((e) => {
    const inv = e.kind === 'invoice' ? invoiceState(entries, e, today) : undefined;
    const kind = e.kind === 'receipt' ? 'Receipt' : e.kind === 'invoice' ? 'Invoice' : 'Quotation';
    const status = e.void ? 'Cancelled' : (inv?.status ?? (e.kind === 'proforma' ? 'Quotation' : 'Paid'));
    return [
      e.date,
      kind,
      e.number,
      e.customer,
      e.currency,
      e.total.toFixed(2),
      (inv?.paid ?? (e.kind === 'receipt' ? e.total : 0)).toFixed(2),
      (inv?.balance ?? 0).toFixed(2),
      status,
      e.against ?? '',
      e.method ?? '',
    ];
  });
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---- storage (this browser only) ---------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round2(v) : 0);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One entry from storage or another device, or undefined when it is damaged. Also used by the server. */
export function cleanEntry(raw: unknown): LedgerEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'receipt' || r.kind === 'invoice' || r.kind === 'proforma' ? r.kind : undefined;
  const number = str(r.number, 40).trim();
  const date = str(r.date, 10);
  if (!kind || !number || !ISO.test(date)) return undefined;
  // The API sends keys in snake_case (paid_at_issue, updated_at); storage and devices use camelCase.
  const updated = r.updatedAt ?? r.updated_at;
  const at = typeof updated === 'number' && Number.isFinite(updated) && updated > 0 ? Math.floor(updated) : undefined;
  return {
    kind,
    number,
    date,
    due: ISO.test(str(r.due, 10)) ? str(r.due, 10) : '',
    customer: str(r.customer, 120),
    currency: r.currency === 'USD' ? 'USD' : 'NLe',
    total: num(r.total),
    paidAtIssue: num(r.paidAtIssue ?? r.paid_at_issue),
    ...(typeof r.against === 'string' && r.against.trim() ? { against: str(r.against, 40) } : {}),
    ...(typeof r.method === 'string' ? { method: str(r.method, 40) } : {}),
    ...(r.void === true ? { void: true } : {}),
    ...(at ? { updatedAt: at } : {}),
  };
}

/** The key two copies of the same document share on every device. */
export const entryKey = (e: Pick<LedgerEntry, 'kind' | 'number'>) => `${e.kind} ${e.number.trim().toLowerCase()}`;

/** Newest document first, as the ledger lists them. */
export const byNewest = (a: LedgerEntry, b: LedgerEntry) => b.date.localeCompare(a.date) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** Reads a business's ledger, dropping anything damaged. */
export function loadLedger(business = 'main'): LedgerEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(keyOf(business)) ?? '[]');
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, LEDGER_MAX)
    .map(cleanEntry)
    .filter((e): e is LedgerEntry => !!e);
}

export function saveLedger(entries: LedgerEntry[], business = 'main'): void {
  try {
    localStorage.setItem(keyOf(business), JSON.stringify(entries.slice(0, LEDGER_MAX)));
  } catch {
    // Private windows and full storage: the ledger lasts until the page closes.
  }
}
