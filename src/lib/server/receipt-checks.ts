import { randomBytes } from 'node:crypto';
import { DomainError, newId, type Clock, type UserPrincipal } from './kernel';
import type { PgPool } from './db/pg';
import { UNIQUE_VIOLATION, pgErr } from './db/pg';
import type { LicenseService } from './licenses';
import { canUsePaid } from '../licensing';

// Receipt checks (docs/receipt-checks.md): the facts of a receipt, invoice or quotation made in the Receipt Maker,
// registered by its issuer so the QR code on the document can show anyone that it was really issued and is still
// valid. The document itself is made on the issuer's device and never uploaded; only these facts and, once the PDF
// is made, its SHA-256 are sent.

export const RECEIPT_KINDS = ['receipt', 'invoice', 'proforma'] as const;
export const RECEIPT_CURRENCIES = ['NLe', 'USD'] as const;
export const RECEIPT_CANCEL_REASONS = ['issued_in_error', 'replaced', 'refunded', 'other'] as const;
/** Registrations per person per day: generous for a busy shop, low enough to stop a script filling the table. */
export const RECEIPT_DAILY_LIMIT = 1000;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 16 symbols from 32 (80 bits): short enough for a small QR code on a till slip, too many to guess. */
const newCode = () => Array.from(randomBytes(16), (b) => ALPHABET[b & 31]).join('');
const CODE = /^[A-Z2-7]{16}$/;

export interface ReceiptCheckInput {
  kind: (typeof RECEIPT_KINDS)[number];
  businessName: string;
  number: string;
  issuedOn: string;
  currency: (typeof RECEIPT_CURRENCIES)[number];
  total: number;
  customerName?: string | undefined;
}

interface Row {
  id: string;
  code: string;
  kind: string;
  business_name: string;
  number: string;
  issued_on: string;
  currency: string;
  total: string;
  customer_name: string | null;
  sha256: string | null;
  status: 'active' | 'cancelled';
  created_at: Date;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

const COLUMNS =
  "id, code, kind, business_name, number, to_char(issued_on, 'YYYY-MM-DD') AS issued_on, currency, total, customer_name, sha256, status, created_at, cancelled_at, cancel_reason";
const invalid = (m: string) => new DomainError('invalid_request', m);
const notFound = () => new DomainError('not_found', 'not found');
const clean = (s: string | undefined, max: number, what: string) => {
  const v = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length > max) throw invalid(`${what} is too long`);
  return v;
};

export class ReceiptCheckService {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  readonly #licenses: LicenseService;
  readonly #origin: string;

  constructor(pool: PgPool, clock: Clock, licenses: LicenseService, publicOrigin: string) {
    this.#pool = pool;
    this.#clock = clock;
    this.#licenses = licenses;
    this.#origin = publicOrigin;
  }

  #view(r: Row) {
    return {
      id: r.id,
      code: r.code,
      url: `${this.#origin}/receipts/${r.code}`,
      kind: r.kind,
      businessName: r.business_name,
      number: r.number,
      issuedOn: r.issued_on,
      currency: r.currency,
      total: Number(r.total),
      customerName: r.customer_name,
      sha256: r.sha256,
      status: r.status,
      createdAt: r.created_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
    };
  }

  /** Registers a document's facts. Needs a confirmed email and access to the Pro tools. */
  async register(p: UserPrincipal, input: ReceiptCheckInput) {
    if (!p.emailVerified) throw new DomainError('forbidden', 'confirm your email address first');
    if (!canUsePaid(await this.#licenses.access(p), this.#clock.now())) throw new DomainError('forbidden', 'the Receipt Maker is a Pro tool');
    const businessName = clean(input.businessName, 120, 'business name');
    const number = clean(input.number, 40, 'number');
    const customerName = clean(input.customerName, 120, 'customer name') || null;
    if (!businessName) throw invalid('business name is required');
    if (!number) throw invalid('number is required');
    if (!RECEIPT_KINDS.includes(input.kind)) throw invalid('unknown document type');
    if (!RECEIPT_CURRENCIES.includes(input.currency)) throw invalid('unknown currency');
    const total = Math.round(Number(input.total) * 100) / 100;
    if (!Number.isFinite(total) || total < 0 || total >= 1e14) throw invalid('total is out of range');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issuedOn) || Number.isNaN(Date.parse(`${input.issuedOn}T00:00:00Z`))) throw invalid('date is invalid');
    const now = this.#clock.now();
    const recent = await this.#pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM receipt_checks WHERE user_id = $1 AND created_at > $2::timestamptz - interval '1 day'",
      [p.userId, now],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= RECEIPT_DAILY_LIMIT) throw new DomainError('rate_limited', 'daily limit reached; try again tomorrow');
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.#pool.query<Row>(
          `INSERT INTO receipt_checks (id, user_id, code, kind, business_name, number, issued_on, currency, total, customer_name, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11) RETURNING ${COLUMNS}`,
          [newId('rck'), p.userId, newCode(), input.kind, businessName, number, input.issuedOn, input.currency, total, customerName, now],
        );
        return this.#view(r.rows[0]!);
      } catch (e) {
        // A code collision is astronomically unlikely; try a fresh one rather than fail.
        if (pgErr(e).code !== UNIQUE_VIOLATION || attempt >= 2) throw e;
      }
    }
  }

  /** Records the SHA-256 of the finished PDF, once, so a holder of the file can check it is the issued one. */
  async setDigest(p: UserPrincipal, id: string, sha256: string) {
    const r = await this.#pool.query<Row>(
      `UPDATE receipt_checks SET sha256 = $3 WHERE id = $1 AND user_id = $2 AND sha256 IS NULL AND status = 'active' RETURNING ${COLUMNS}`,
      [id, p.userId, sha256],
    );
    if (r.rows[0]) return this.#view(r.rows[0]);
    const exists = await this.#pool.query('SELECT 1 FROM receipt_checks WHERE id = $1 AND user_id = $2', [id, p.userId]);
    if (!exists.rows[0]) throw notFound();
    throw new DomainError('conflict', 'this document already has a file fingerprint, or was cancelled');
  }

  /** Permanent: the public page then says the document was cancelled, and when. */
  async cancel(p: UserPrincipal, id: string, reason: (typeof RECEIPT_CANCEL_REASONS)[number]) {
    if (!RECEIPT_CANCEL_REASONS.includes(reason)) throw invalid('unknown reason');
    const r = await this.#pool.query<Row>(
      `UPDATE receipt_checks SET status = 'cancelled', cancelled_at = $3, cancel_reason = $4
       WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING ${COLUMNS}`,
      [id, p.userId, this.#clock.now(), reason],
    );
    if (r.rows[0]) return this.#view(r.rows[0]);
    const exists = await this.#pool.query('SELECT 1 FROM receipt_checks WHERE id = $1 AND user_id = $2', [id, p.userId]);
    if (!exists.rows[0]) throw notFound();
    throw new DomainError('conflict', 'this document is already cancelled');
  }

  /** The caller's registered documents, newest first. */
  async list(p: UserPrincipal, limit = 200) {
    const r = await this.#pool.query<Row>(`SELECT ${COLUMNS} FROM receipt_checks WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT $2`, [
      p.userId,
      Math.min(500, Math.max(1, limit)),
    ]);
    return r.rows.map((x) => this.#view(x));
  }

  /** What the public check page shows. Unknown and malformed codes are the same 404. */
  async publicView(raw: string) {
    const code = String(raw ?? '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    if (!CODE.test(code)) throw notFound();
    const r = await this.#pool.query<Row>(`SELECT ${COLUMNS} FROM receipt_checks WHERE code = $1`, [code]);
    const row = r.rows[0];
    if (!row) throw notFound();
    const v = this.#view(row);
    // Never the issuer's account or internal id.
    return {
      code: v.code,
      kind: v.kind,
      businessName: v.businessName,
      number: v.number,
      issuedOn: v.issuedOn,
      currency: v.currency,
      total: v.total,
      customerName: v.customerName,
      sha256: v.sha256,
      status: v.status,
      registeredAt: v.createdAt,
      cancelledAt: v.cancelledAt,
      cancelReason: v.cancelReason,
    };
  }
}
