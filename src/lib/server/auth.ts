import { DomainError, sha256Hex, type UserPrincipal } from './kernel';

/** Verifies a Supabase access token and returns the user it belongs to. */
export interface TokenVerifier {
  verify(token: string): Promise<UserPrincipal | undefined>;
}

/**
 * Asks Supabase Auth (`GET /auth/v1/user`) whether the token is valid. This works for both legacy (HS256) and
 * asymmetric signing keys and reflects sign-out/revocation. Results are cached briefly by token digest (never the
 * token itself) to avoid a round trip per request.
 */
export class SupabaseTokenVerifier implements TokenVerifier {
  readonly #url: string;
  readonly #key: string;
  readonly #cache = new Map<string, { at: number; p: UserPrincipal | undefined }>();
  readonly #ttlMs: number;

  constructor(opts: { supabaseUrl: string; publishableKey: string; cacheSeconds?: number }) {
    this.#url = opts.supabaseUrl.replace(/\/$/, '');
    this.#key = opts.publishableKey;
    this.#ttlMs = (opts.cacheSeconds ?? 30) * 1000;
  }

  async verify(token: string): Promise<UserPrincipal | undefined> {
    const k = sha256Hex(token);
    const hit = this.#cache.get(k);
    if (hit && Date.now() - hit.at < this.#ttlMs) return hit.p;
    const res = await fetch(`${this.#url}/auth/v1/user`, {
      headers: { apikey: this.#key, authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    let p: UserPrincipal | undefined;
    if (res.ok) {
      const u = (await res.json()) as { id?: string; email?: string; email_confirmed_at?: string | null };
      if (u.id && u.email) p = { userId: u.id, email: u.email.toLowerCase(), emailVerified: !!u.email_confirmed_at };
    } else if (res.status >= 500) throw new Error('auth provider unavailable');
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(k, { at: Date.now(), p });
    return p;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/;

/** Required authentication: a valid bearer token or 401. */
export async function authenticate(v: TokenVerifier, header: string | null): Promise<UserPrincipal> {
  const m = header ? BEARER.exec(header) : null;
  const p = m ? await v.verify(m[1]!) : undefined;
  if (!p) throw new DomainError('unauthenticated', 'authentication required');
  return p;
}
