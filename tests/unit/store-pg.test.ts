import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll } from 'vitest';
import { PgSharingStore } from '@/lib/server/db/pg-sharing-store';
import { applyMigrations, MIGRATIONS_DIR } from '@/lib/server/db/schema';
import { sharingStoreContract } from './store-contract';

const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
const pools: pg.Pool[] = [];
afterAll(async () => {
  for (const p of pools) await p.end();
});

sharingStoreContract('postgres', async () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await admin.connect();
  await applyMigrations(admin, MIGRATIONS_DIR, schema);
  await admin.end();
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 6, options: `-c search_path=${schema}` });
  pools.push(pool);
  return {
    store: new PgSharingStore(pool, clock),
    audited: async () => (await pool.query('SELECT action FROM audit_events ORDER BY seq')).rows.map((r) => r.action as string),
    seed: async () => {
      const s = randomBytes(12).toString('hex');
      const ids = { orgId: `org_${s}`, userId: crypto.randomUUID() };
      await pool.query("INSERT INTO organizations (id, name, kind, created_at) VALUES ($1,$1,'team',now())", [ids.orgId]);
      await pool.query("INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ($1, $1 || '@x.test', true, now(), now())", [ids.userId]);
      return ids;
    },
  };
});
