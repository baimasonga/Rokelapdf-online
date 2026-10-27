import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

// Forward-only migrations into a private schema (never `public`, so Supabase's auto-generated Data API cannot see
// the data) and least-privilege grants for the application role, which owns nothing.

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertIdent(name: string): string {
  if (!SCHEMA_NAME.test(name)) throw new Error('invalid identifier');
  return name;
}

export const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function applyMigrations(client: Client, dir: string, schema: string) {
  const s = assertIdent(schema);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  await client.query(`SET search_path TO "${s}"`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query('SELECT pg_advisory_lock(727275)');
  const result = { applied: [] as string[], skipped: [] as string[] };
  try {
    for (const f of readdirSync(dir)
      .filter((x) => FILE.test(x))
      .sort()) {
      const version = f.replace(/\.sql$/, '');
      const sql = readFileSync(join(dir, f), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const row = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
      if (row.rows[0]) {
        if (row.rows[0].checksum !== checksum) throw new Error(`migration ${version} was modified after being applied`);
        result.skipped.push(version);
        continue;
      }
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
      result.applied.push(version);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727275)');
  }
}

type Priv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const R: Priv[] = ['SELECT'];
const RI: Priv[] = ['SELECT', 'INSERT'];
const RIU: Priv[] = ['SELECT', 'INSERT', 'UPDATE'];
const ALL: Priv[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Every table needs an explicit policy: an unlisted table makes grants fail, forcing a deliberate decision. */
export const TABLE_PRIVILEGES: Record<string, Priv[]> = {
  warrior_outbox: ALL,
  warrior_monitor_state: RIU,
  schema_migrations: R,
  users: RIU,
  organizations: RI,
  memberships: ALL, // members can be removed or leave
  member_invitations: RIU,
  org_plans: R, // operators change plans through tooling with the owner connection
  user_licenses: R, // likewise for licences
  receipt_checks: RIU, // evidence: never deleted (a trigger also refuses DELETE)
  receipt_sync_entries: RIU, // a document is cancelled (void), never deleted
  receipt_sync_profiles: RIU,
  audit_events: RI, // append-only
  rate_limits: ALL,
  share_accounts: RIU, // lock anchor (row locks need UPDATE)
  share_blobs: RIU,
  share_documents: RIU,
  share_versions: RIU,
  share_transfers: RIU,
  share_transfer_files: RIU,
  share_links: RIU,
  share_comments: RI,
  share_reviews: RIU,
  short_links: RIU,
  short_link_destinations: RI,
  upload_requests: RIU,
  upload_submissions: RIU,
  upload_submission_files: RIU,
  share_events: ['SELECT', 'INSERT', 'DELETE'],
  share_stats: ALL,
  share_notifications: ALL,
  share_jobs: ALL,
  share_domains: ALL,
  share_brands: RIU,
  abuse_reports: RIU,
  verified_documents: RIU, // evidence: never deleted (a trigger also refuses DELETE)
  share_usage: RIU,
  share_attempts: ALL,
};

export function planGrants(schema: string, role: string, tables: string[]): string[] {
  const s = `"${assertIdent(schema)}"`;
  const r = `"${assertIdent(role)}"`;
  const unknown = tables.filter((t) => !(t in TABLE_PRIVILEGES));
  if (unknown.length) throw new Error(`no grant policy for table(s): ${unknown.join(', ')} (add them to TABLE_PRIVILEGES)`);
  const out = [`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`, `REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`, `GRANT USAGE ON SCHEMA ${s} TO ${r}`];
  for (const t of [...tables].sort()) out.push(`GRANT ${TABLE_PRIVILEGES[t]!.join(', ')} ON TABLE ${s}."${t}" TO ${r}`);
  out.push(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
  out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${r}`);
  return out;
}

export async function applyGrants(client: Client, schema: string, role: string) {
  const me = (await client.query('SELECT current_user AS u')).rows[0].u as string;
  if (me === role) throw new Error('the application role must differ from the schema owner');
  const r = (await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [role])).rows[0];
  if (!r) throw new Error(`role "${role}" does not exist (create it first; see docs/deploy.md)`);
  if (r.rolsuper) throw new Error(`role "${role}" is a superuser; use a least-privilege role`);
  const tables = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [schema])).rows.map((x) => x.tablename as string);
  // Supabase's API roles never get access to this schema.
  const apiRoles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows;
  const stmts = planGrants(schema, role, tables);
  for (const a of apiRoles) stmts.push(`REVOKE ALL ON SCHEMA "${assertIdent(schema)}" FROM "${a.rolname}"`);
  // The app's unqualified table names resolve to this schema even behind a pooler that drops startup parameters.
  const db = (await client.query('SELECT current_database() AS d')).rows[0].d as string;
  stmts.push(`ALTER ROLE "${assertIdent(role)}" IN DATABASE "${db.replace(/"/g, '""')}" SET search_path TO "${assertIdent(schema)}"`);
  await client.query('BEGIN');
  try {
    for (const q of stmts) await client.query(q);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return stmts;
}
