import type { Clock, UserPrincipal } from './kernel';
import type { PgPool } from './db/pg';
import { resolveAccess, type Access } from '../licensing';

/**
 * A person's access to the paid tools (src/lib/licensing.ts): any licence held for their email, otherwise the free
 * month from their first sign-in. Read-only: licences are granted by operators through tooling (admin.ts).
 */
export class LicenseService {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  readonly #paidFrom: Date | undefined;

  constructor(pool: PgPool, clock: Clock, paidFrom: Date | undefined) {
    this.#pool = pool;
    this.#clock = clock;
    this.#paidFrom = paidFrom;
  }

  /** The caller must be synced first (every signed-in route is), so their first sign-in is recorded. */
  async access(p: UserPrincipal): Promise<Access> {
    const now = this.#clock.now();
    if (!this.#paidFrom || now < this.#paidFrom)
      return resolveAccess({ now, paidFrom: this.#paidFrom, firstSeen: now, emailVerified: false, license: undefined });
    const user = await this.#pool.query('SELECT created_at FROM users WHERE id = $1', [p.userId]);
    const lic = await this.#pool.query('SELECT valid_from, valid_until FROM user_licenses WHERE email = $1', [p.email]);
    const l = lic.rows[0] as { valid_from: Date; valid_until: Date } | undefined;
    return resolveAccess({
      now,
      paidFrom: this.#paidFrom,
      firstSeen: (user.rows[0] as { created_at: Date } | undefined)?.created_at ?? now,
      emailVerified: p.emailVerified,
      license: l ? { from: l.valid_from, until: l.valid_until } : undefined,
    });
  }
}
