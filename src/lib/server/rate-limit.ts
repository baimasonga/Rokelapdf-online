import type { Clock } from './kernel';
import type { PgPool } from './db/pg';

/** Fixed-window counters in PostgreSQL, shared by every instance. Fails open on database errors (availability). */
export class RateLimiter {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  constructor(pool: PgPool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async hit(key: string, limit: number, windowSeconds = 60): Promise<boolean> {
    const now = this.#clock.now().getTime();
    const start = new Date(now - (now % (windowSeconds * 1000)));
    try {
      const r = await this.#pool.query(
        `INSERT INTO rate_limits (key, window_start, count) VALUES ($1,$2,1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`,
        [key.slice(0, 200), start],
      );
      return Number(r.rows[0].count) <= limit;
    } catch {
      return true;
    }
  }

  async purge(before: Date): Promise<number> {
    const r = await this.#pool.query('DELETE FROM rate_limits WHERE ctid IN (SELECT ctid FROM rate_limits WHERE window_start < $1 LIMIT 5000)', [before]);
    return r.rowCount ?? 0;
  }
}
