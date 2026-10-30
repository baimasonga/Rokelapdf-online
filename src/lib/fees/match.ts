// Receipt processing rules shared by the server and the browser (docs/receipt-processing.md): reference normalization, money in
// minor units, and matching declared payments against bank statement lines. No dependencies; pure functions.

export const FEE_CURRENCIES = ['NLe', 'USD'] as const;
export type FeeCurrency = (typeof FEE_CURRENCIES)[number];

/** Statement lines one request may carry (the API body limit is 64 KB). */
export const STATEMENT_BATCH = 200;

/**
 * Splits statement lines into requests that fit the API's 64 KiB body limit: at most STATEMENT_BATCH lines and
 * `maxChars` of JSON each, counting `overhead` (the rest of the request body) once per batch.
 */
export function statementBatches<T>(lines: readonly T[], overhead: number, maxChars = 60_000): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let size = overhead;
  for (const line of lines) {
    const n = JSON.stringify(line).length + 1;
    if (batch.length && (batch.length >= STATEMENT_BATCH || size + n > maxChars)) {
      out.push(batch);
      batch = [];
      size = overhead;
    }
    batch.push(line);
    size += n;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** Upper-case letters and digits only: "ft-2026/0012 34" and "FT2026001234" are the same reference. */
export function referenceKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Parses "1,500.00", "NLe 1 500", "(250.50)" or "-250.5" into minor units; undefined when it is not an amount. */
export function parseAmount(raw: string | number): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : undefined;
  let s = raw.trim();
  if (!s) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const marked = /^(.*?\d)\s*(DR|CR)$/i.exec(s);
  if (marked) {
    negative = marked[2]!.toUpperCase() === 'DR';
    s = marked[1]!;
  }
  s = s.replace(/^[A-Za-z$€£\s]+|[A-Za-z$€£\s]+$/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/[\s ,']/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [whole, frac = ''] = s.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return undefined;
  return negative ? -minor : minor;
}

/** "fee-clearance-certificate-FBC-2024-123.pdf": the certificate's download name, the same for the payer and finance. */
export function certificateFileName(certificateTitle: string, payer: string): string {
  const part = (v: string) => v.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'certificate';
  return `${part(certificateTitle).toLowerCase()}-${part(payer)}.pdf`;
}

export function formatAmount(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${currency} ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dayNumber = (iso: string) => Math.round(new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000);
export const daysBetween = (a: string, b: string) => Math.abs(dayNumber(a) - dayNumber(b));

export interface StatementLine {
  reference: string;
  description: string;
  /** Minor units; only credits (money received) are matched. */
  amount: number;
  date: string;
}

export interface ClaimToMatch {
  id: string;
  referenceKey: string;
  payerId: string | null;
  amount: number;
  paidOn: string;
}

export interface MatchResult {
  matches: Array<{ claimId: string; line: number; payerIdFound: boolean }>;
  /** Claims whose reference is on the statement but whose amount or date is not. */
  issues: Array<{ claimId: string; issue: string }>;
}

/** The reference appears in the line: exactly in its reference column, or (6+ characters) inside either text. */
function mentions(line: StatementLine, key: string): boolean {
  const ref = referenceKey(line.reference);
  if (ref === key) return true;
  return key.length >= 6 && (ref.includes(key) || referenceKey(line.description).includes(key));
}

/**
 * Matches declared payments to statement credits. A claim matches a line that names its reference, for exactly the
 * declared amount, dated within `toleranceDays` of the declared date. Each line confirms at most one claim; lines in
 * `used` (already confirming a claim) are skipped. The bank statement is the authority: nothing else clears a claim.
 */
export function matchStatement(
  claims: readonly ClaimToMatch[],
  lines: readonly StatementLine[],
  toleranceDays: number,
  currency: string,
  used: ReadonlySet<number> = new Set(),
): MatchResult {
  const taken = new Set(used);
  const out: MatchResult = { matches: [], issues: [] };
  for (const c of claims) {
    const candidates = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => !taken.has(i) && l.amount > 0 && mentions(l, c.referenceKey));
    if (!candidates.length) continue;
    const exact = candidates
      .filter(({ l }) => l.amount === c.amount && daysBetween(l.date, c.paidOn) <= toleranceDays)
      .sort((a, b) => daysBetween(a.l.date, c.paidOn) - daysBetween(b.l.date, c.paidOn));
    if (exact.length) {
      const { l, i } = exact[0]!;
      taken.add(i);
      const sid = referenceKey(c.payerId ?? '');
      out.matches.push({
        claimId: c.id,
        line: i,
        payerIdFound: sid.length >= 3 && (referenceKey(l.description).includes(sid) || referenceKey(l.reference).includes(sid)),
      });
      continue;
    }
    const { l } = candidates[0]!;
    out.issues.push({
      claimId: c.id,
      issue:
        l.amount !== c.amount
          ? `The reference is on the statement for ${formatAmount(l.amount, currency)}, not ${formatAmount(c.amount, currency)}.`
          : `The reference is on the statement dated ${l.date}, ${daysBetween(l.date, c.paidOn)} days from the declared ${c.paidOn}.`,
    });
  }
  return out;
}
