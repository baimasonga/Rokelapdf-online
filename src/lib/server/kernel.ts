// Shared kernel for the server: errors, identifiers, hashing, clock, principal and the audit writer contract.
// Server-only: never import from client components.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Stable, client-visible error codes. Never change a code's meaning; add new ones. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  password_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  quota_exceeded: 409,
  link_unavailable: 410,
  rate_limited: 429,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

// Next.js bundles the background worker (instrumentation) and the route handlers separately, so one process can hold
// two copies of this class. A registered symbol makes `instanceof DomainError` hold across those copies.
const DOMAIN_ERROR = Symbol.for('rokela.DomainError');

export class DomainError extends Error {
  static [Symbol.hasInstance](v: unknown): boolean {
    return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[DOMAIN_ERROR] === true;
  }
  readonly [DOMAIN_ERROR] = true;
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, Json> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, Json>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** An authenticated user, produced only by the server from a verified Supabase access token. */
export interface UserPrincipal {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function hmacSha256Hex(key: string | Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** Opaque, prefixed, unguessable identifier (96 bits). Identifiers are not secrets or authority. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

// ---- audit -----------------------------------------------------------------------------------------------
export interface AuditEventInput {
  actor: { type: 'user' | 'system' | 'anonymous' | 'operator'; id?: string | undefined };
  /** Dotted verb, e.g. `share.link.revoked`. */
  action: string;
  target?: { type: string; id: string } | undefined;
  orgId?: string | undefined;
  /** Free text must not contain secrets. Mandatory for operator mutations. */
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}
/** Write-only audit handle given to a store transaction: events commit atomically with the change. */
export interface AuditWriter {
  append(input: AuditEventInput): Promise<void>;
}
export interface AuditLog {
  appendMany(inputs: readonly AuditEventInput[]): Promise<void>;
}
export class AuditBuffer implements AuditWriter {
  #events: AuditEventInput[] = [];
  async append(input: AuditEventInput): Promise<void> {
    this.#events.push(input);
  }
  drain(): AuditEventInput[] {
    const out = this.#events;
    this.#events = [];
    return out;
  }
}
