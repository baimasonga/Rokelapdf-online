import type { AuditEventInput, Clock } from '../kernel';
import type { Queryable } from './pg';

/** Writes audit events inside the caller's transaction, so a change and its audit record commit together. */
export async function appendAuditInTx(q: Queryable, clock: Clock, inputs: readonly AuditEventInput[]): Promise<void> {
  if (!inputs.length) return;
  const at = clock.now();
  for (const e of inputs)
    await q.query(
      `INSERT INTO audit_events (occurred_at, actor_type, actor_id, action, target_type, target_id, org_id, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        at,
        e.actor.type,
        e.actor.id ?? null,
        e.action,
        e.target?.type ?? null,
        e.target?.id ?? null,
        e.orgId ?? null,
        e.reason ?? null,
        JSON.stringify(e.metadata ?? {}),
      ],
    );
}
