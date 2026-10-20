import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTransaction, type PgPool } from './db/pg';
import type { Clock } from './kernel';
import type { WarriorConfig } from './warrior-config';
const component = z.string().regex(/^opm_[a-f0-9]{24}$/);
const duration = z.number().int().min(0).max(86400000);
const formats = z.enum(['pdf', 'image', 'office', 'text', 'other']);
const safeEvent = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('component.heartbeat'), attributes: z.object({ status: z.enum(['healthy', 'unknown', 'degraded', 'unavailable']) }).strict() })
    .strict(),
  z
    .object({
      type: z.literal('conversion.failed'),
      attributes: z
        .object({
          source_type: formats,
          target_type: formats,
          reason: z.enum(['timeout', 'unsupported', 'worker_unavailable', 'internal']),
          duration_ms: duration,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('scanner.unavailable'),
      attributes: z
        .object({
          reason: z.enum(['timeout', 'connection', 'worker_unavailable']),
          queue_age_seconds: z.number().int().min(0).max(604800),
          queue_count: z.number().int().min(0).max(1000000),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('malware.detected'), attributes: z.object({ verdict: z.enum(['malicious', 'suspicious']) }).strict() }).strict(),
]);
export type WarriorEvent = z.infer<typeof safeEvent>;
const endpoint = 'https://trustplatform-api-production.up.railway.app/v1/operations/events';
export class WarriorMonitor {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  readonly #config: WarriorConfig;
  readonly #fetch: typeof fetch;
  constructor(pool: PgPool, clock: Clock, config: WarriorConfig, transport: typeof fetch = fetch) {
    this.#pool = pool;
    this.#clock = clock;
    this.#config = config;
    this.#fetch = transport;
  }
  async capture(componentId: string, value: unknown): Promise<boolean> {
    const event = safeEvent.safeParse(value);
    if (
      !event.success ||
      !component.safeParse(componentId).success ||
      ![this.#config.apiComponentId, this.#config.converterComponentId, this.#config.scannerComponentId].includes(componentId)
    )
      return false;
    const now = this.#clock.now(),
      id = randomUUID();
    const envelope = { id, component_id: componentId, occurred_at: now.toISOString(), ...event.data };
    const key = event.data.type === 'component.heartbeat' ? `${componentId}:${Math.floor(+now / 60000)}:${event.data.attributes.status}` : null;
    try {
      return await withTransaction(this.#pool, async (q) => {
        await q.query('SELECT pg_advisory_xact_lock(914739)');
        await q.query('DELETE FROM warrior_outbox WHERE id IN (SELECT id FROM warrior_outbox WHERE deadline<=$1 ORDER BY deadline LIMIT 100)', [
          new Date(+now - 3600000),
        ]);
        if (key && (await q.query('SELECT 1 FROM warrior_outbox WHERE coalesce_key=$1', [key])).rowCount) return true;
        if (Number((await q.query('SELECT count(*)::int AS n FROM warrior_outbox')).rows[0].n) >= 1000) {
          await q.query("UPDATE warrior_monitor_state SET dropped=dropped+1,last_failure='queue_full' WHERE id=1");
          return false;
        }
        await q.query(
          "INSERT INTO warrior_outbox(id,component_id,envelope,coalesce_key,created_at,available_at,deadline,state) VALUES ($1,$2,$3,$4,$5,$5,$6,'pending')",
          [id, componentId, JSON.stringify(envelope), key, now, new Date(+now + 23 * 3600000)],
        );
        return true;
      });
    } catch {
      return false;
    }
  }
  async flush(): Promise<void> {
    const now = this.#clock.now(),
      fence = randomUUID();
    const rows = await withTransaction(this.#pool, async (q) => {
      await q.query("UPDATE warrior_outbox SET state='failed',claim_token=NULL,lease_until=NULL WHERE state<>'failed' AND deadline<=$1", [now]);
      const r = await q.query(
        "WITH due AS (SELECT id FROM warrior_outbox WHERE deadline>$1 AND ((state='pending' AND available_at<=$1) OR (state='claimed' AND lease_until<=$1)) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 50) UPDATE warrior_outbox o SET state='claimed',claim_token=$2,lease_until=$3,attempts=o.attempts+1 FROM due WHERE o.id=due.id RETURNING o.id,o.envelope,o.attempts",
        [now, fence, new Date(+now + 15000)],
      );
      return r.rows;
    });
    if (!rows.length) return;
    let accepted = false,
      rejected = false;
    try {
      const response = await this.#fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${this.#config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 1, events: rows.map((r) => r.envelope) }),
        signal: AbortSignal.timeout(5000),
      });
      rejected = [400, 409, 413, 415, 422].includes(response.status);
      if (response.ok) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('missing acknowledgement');
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 32768) {
            await reader.cancel();
            throw new Error('acknowledgement exceeds budget');
          }
          chunks.push(r.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
        const ack = JSON.parse(new TextDecoder().decode(bytes)) as { accepted?: { id?: unknown; disposition?: unknown }[] };
        accepted =
          Array.isArray(ack.accepted) &&
          ack.accepted.length === rows.length &&
          new Set(ack.accepted.map((a) => a.id)).size === rows.length &&
          rows.every((r) => ack.accepted!.some((a) => a.id === r.id && ['stored', 'duplicate'].includes(a.disposition as string)));
      } else await response.body?.cancel();
    } catch {
      /* Treat every ambiguous outcome as a retry of the same persisted IDs. */
    }
    await withTransaction(this.#pool, async (q) => {
      const at = this.#clock.now();
      for (const row of rows) {
        if (accepted) {
          await q.query("DELETE FROM warrior_outbox WHERE id=$1 AND claim_token=$2 AND state='claimed' AND lease_until>$3", [row.id, fence, at]);
        } else
          await q.query(
            "UPDATE warrior_outbox SET state=$4,claim_token=NULL,lease_until=NULL,available_at=$5 WHERE id=$1 AND claim_token=$2 AND state='claimed' AND lease_until>$3",
            [row.id, fence, at, rejected ? 'failed' : 'pending', new Date(+at + Math.min(300, 2 ** Math.min(9, Number(row.attempts))) * 1000)],
          );
      }
      await q.query('UPDATE warrior_monitor_state SET last_ack_at=CASE WHEN $1 THEN $2 ELSE last_ack_at END,last_failure=$3 WHERE id=1', [
        accepted,
        at,
        accepted ? null : rejected ? 'rejected' : 'transport',
      ]);
    });
  }
  async scannerUnavailable(componentId: string) {
    try {
      const r = await this.#pool.query("SELECT count(*)::int AS n,min(created_at) AS oldest FROM share_jobs WHERE kind='scan'");
      const row = r.rows[0];
      await this.capture(componentId, {
        type: 'scanner.unavailable',
        attributes: {
          reason: 'worker_unavailable',
          queue_count: Math.min(1000000, Number(row.n)),
          queue_age_seconds: row.oldest ? Math.max(0, Math.min(604800, Math.floor((+this.#clock.now() - +new Date(row.oldest)) / 1000))) : 0,
        },
      });
    } catch {
      /* Monitoring cannot replace the scanner's original result. */
    }
  }
  async status() {
    const r = await this.#pool.query(
      "SELECT count(*) FILTER(WHERE state='pending')::int AS pending,count(*) FILTER(WHERE state='claimed')::int AS claimed,count(*) FILTER(WHERE state='failed')::int AS failed,min(created_at) FILTER(WHERE state<>'failed') AS oldest_pending_at FROM warrior_outbox",
    );
    const s = await this.#pool.query('SELECT dropped,last_ack_at,last_failure FROM warrior_monitor_state WHERE id=1');
    return {
      pending: Number(r.rows[0]?.pending ?? 0),
      claimed: Number(r.rows[0]?.claimed ?? 0),
      failed: Number(r.rows[0]?.failed ?? 0),
      oldest_pending_at: r.rows[0]?.oldest_pending_at ?? null,
      dropped: Number(s.rows[0]?.dropped ?? 0),
      last_ack_at: s.rows[0]?.last_ack_at ?? null,
      last_failure: s.rows[0]?.last_failure ?? null,
    };
  }
}
