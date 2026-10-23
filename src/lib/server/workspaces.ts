import { DomainError, newId, type AuditEventInput, type Clock, type UserPrincipal } from './kernel';
import { withTransaction, type PgPool, type Queryable } from './db/pg';
import { appendAuditInTx } from './db/audit';

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
export type Permission = 'org:read' | 'org:manage_members' | 'share:read' | 'share:create' | 'share:manage';

// Deny by default: a permission not listed for a role is not granted.
const GRANTS: Record<Role, readonly Permission[]> = {
  member: ['org:read', 'share:read', 'share:create'],
  admin: ['org:read', 'org:manage_members', 'share:read', 'share:create', 'share:manage'],
  owner: ['org:read', 'org:manage_members', 'share:read', 'share:create', 'share:manage'],
};
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export interface Workspace {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: Role;
}

/**
 * Workspaces, membership and roles. Identity comes from verified Supabase access tokens; this service mirrors the
 * user, gives every user a personal workspace, and authorizes workspace-scoped actions. Non-members get 404 (no
 * existence oracle); members lacking a permission get 403.
 */
export class WorkspaceService {
  readonly #pool: PgPool;
  readonly #clock: Clock;
  readonly #trialMode: boolean;

  constructor(pool: PgPool, clock: Clock, trialMode = false) {
    this.#pool = pool;
    this.#clock = clock;
    this.#trialMode = trialMode;
  }

  async #tx<T>(fn: (q: Queryable, audit: AuditEventInput[]) => Promise<T>): Promise<T> {
    return withTransaction(this.#pool, async (client) => {
      const audit: AuditEventInput[] = [];
      const out = await fn(client, audit);
      await appendAuditInTx(client, this.#clock, audit);
      return out;
    });
  }

  /** Upserts the user mirror and creates the personal workspace on first sign-in. Idempotent and race-safe. */
  async sync(p: UserPrincipal): Promise<void> {
    await this.#tx(async (q, audit) => {
      const now = this.#clock.now();
      // Supabase holds each email on one account at a time, so a mirror row with this email but another id is stale
      // (the account was deleted and re-created, or emails moved between accounts). Release the address so the
      // upsert below cannot fail on the unique email index and lock this user out of every request.
      await q.query(`UPDATE users SET email = 'released+' || id || '@invalid', email_verified = false, updated_at = $3 WHERE email = $2 AND id <> $1`, [
        p.userId,
        p.email,
        now,
      ]);
      const r = await q.query(
        `INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified, updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS inserted`,
        [p.userId, p.email, p.emailVerified, now],
      );
      // Lock the user row so concurrent first requests create exactly one personal workspace.
      await q.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [p.userId]);
      const has = await q.query(`SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.kind = 'personal'`, [p.userId]);
      if (has.rowCount) return;
      const id = newId('org');
      await q.query("INSERT INTO organizations (id, name, kind, created_at) VALUES ($1, 'Personal', 'personal', $2)", [id, now]);
      await q.query("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)", [id, p.userId, now]);
      audit.push({
        actor: { type: 'user', id: p.userId },
        action: r.rows[0]?.inserted ? 'user.registered' : 'org.created',
        target: { type: 'org', id },
        orgId: id,
      });
    });
  }

  async list(p: UserPrincipal): Promise<Workspace[]> {
    const r = await this.#pool.query(
      `SELECT o.id, o.name, o.kind, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY (o.kind = 'personal') DESC, o.created_at`,
      [p.userId],
    );
    return r.rows as Workspace[];
  }

  async require(p: UserPrincipal, orgId: string, permission: Permission): Promise<Role> {
    const r = await this.#pool.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, p.userId]);
    const role = r.rows[0]?.role as Role | undefined;
    if (!role) throw new DomainError('not_found', 'not found');
    if (!GRANTS[role].includes(permission)) throw new DomainError('forbidden', 'insufficient permissions');
    return role;
  }

  async isMember(orgId: string, userId: string): Promise<boolean> {
    return !!(await this.#pool.query('SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rowCount;
  }

  async contact(userId: string): Promise<{ email: string; emailVerified: boolean } | undefined> {
    const r = await this.#pool.query('SELECT email, email_verified FROM users WHERE id = $1', [userId]);
    return r.rows[0] ? { email: r.rows[0].email, emailVerified: r.rows[0].email_verified } : undefined;
  }

  async isOperator(userId: string): Promise<boolean> {
    return (await this.#pool.query('SELECT is_operator FROM users WHERE id = $1', [userId])).rows[0]?.is_operator === true;
  }

  /** Plan entitlements set by operators; an organization without a plan gets the free baseline. */
  async entitlements(orgId: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.#pool.query('SELECT entitlements FROM org_plans WHERE org_id = $1', [orgId]);
    return r.rows.map((x) => x.entitlements as Record<string, unknown>);
  }

  /** One workspace plan covers every product; service-specific subscriptions are not created. */
  async subscription(p: UserPrincipal, orgId: string) {
    await this.require(p, orgId, 'org:read');
    const result = await this.#pool.query('SELECT plan, updated_at FROM org_plans WHERE org_id = $1', [orgId]);
    const row = result.rows[0];
    return {
      plan: (!row || row.plan === 'free') && this.#trialMode ? 'trial' : (row?.plan ?? 'free'),
      trialActive: this.#trialMode,
      scope: 'workspace',
      billingMode: 'operator_managed',
      services: ['pdf', 'file_transfer', 'link_shortener'],
      updatedAt: row?.updated_at ?? null,
    };
  }

  async auditLog(p: UserPrincipal, orgId: string, input: { action?: string; before?: string }) {
    await this.require(p, orgId, 'share:manage');
    const result = await this.#pool.query(
      `SELECT seq::text, occurred_at, actor_type, actor_id, action, target_type, target_id, reason
       FROM audit_events WHERE org_id = $1 AND ($2::text IS NULL OR action = $2)
       AND ($3::bigint IS NULL OR seq < $3::bigint) ORDER BY seq DESC LIMIT 101`,
      [orgId, input.action || null, input.before ?? null],
    );
    const items = result.rows.slice(0, 100);
    return { items, nextCursor: result.rows.length > 100 ? items[items.length - 1]!.seq : null };
  }

  async exportMetadata(p: UserPrincipal, orgId: string) {
    await this.require(p, orgId, 'share:manage');
    return this.#tx(async (q, audit) => {
      const tables: Record<string, string> = {
        documents: 'id, title, status, require_approval, created_at, updated_at',
        transfers: 'id, title, kind, status, expires_at, created_at, updated_at',
        versions: 'id, document_id, number, file_name, created_at, published_at',
        links: 'id, target_type, target_id, permission, label, status, expires_at, created_at',
        short_links: 'id, kind, code, destination_type, destination_url, label, folder, tags, status, expires_at, created_at',
      };
      const names: Record<string, string> = {
        documents: 'share_documents',
        transfers: 'share_transfers',
        versions: 'share_versions',
        links: 'share_links',
        short_links: 'short_links',
      };
      const data: Record<string, unknown> = {};
      const truncated: string[] = [];
      for (const [key, columns] of Object.entries(tables)) {
        const result = await q.query(`SELECT ${columns} FROM ${names[key]} WHERE org_id = $1 ORDER BY created_at, id LIMIT 10001`, [orgId]);
        data[key] = result.rows.slice(0, 10000);
        if (result.rows.length > 10000) truncated.push(key);
      }
      audit.push({ actor: { type: 'user', id: p.userId }, action: 'org.metadata.exported', target: { type: 'org', id: orgId }, orgId });
      return {
        workspaceId: orgId,
        exportedAt: this.#clock.now(),
        formatVersion: 1,
        excludes: ['file_contents', 'credentials', 'password_hashes', 'access_tokens'],
        rowLimitPerCollection: 10000,
        truncated,
        data,
      };
    });
  }

  async createTeam(p: UserPrincipal, name: string): Promise<Workspace> {
    const n = name.trim();
    if (n.length < 1 || n.length > 200) throw new DomainError('invalid_request', 'invalid workspace name');
    return this.#tx(async (q, audit) => {
      const now = this.#clock.now();
      const id = newId('org');
      await q.query("INSERT INTO organizations (id, name, kind, created_at) VALUES ($1,$2,'team',$3)", [id, n, now]);
      await q.query("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,'owner',$3)", [id, p.userId, now]);
      audit.push({ actor: { type: 'user', id: p.userId }, action: 'org.created', target: { type: 'org', id }, orgId: id });
      return { id, name: n, kind: 'team' as const, role: 'owner' as const };
    });
  }

  async members(p: UserPrincipal, orgId: string) {
    await this.require(p, orgId, 'org:read');
    const r = await this.#pool.query(
      'SELECT u.id AS user_id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at',
      [orgId],
    );
    return r.rows as Array<{ user_id: string; email: string; role: Role }>;
  }

  /** Adds an existing user (they must have signed in once). An actor may grant at most their own role. */
  async addMember(p: UserPrincipal, orgId: string, email: string, role: Role) {
    const actor = await this.require(p, orgId, 'org:manage_members');
    if (RANK[role] > RANK[actor] || (role === 'owner' && actor !== 'owner')) throw new DomainError('forbidden', 'cannot grant a role above your own');
    return this.#tx(async (q, audit) => {
      const org = (await q.query('SELECT kind FROM organizations WHERE id = $1', [orgId])).rows[0];
      if (!org || org.kind === 'personal') throw new DomainError('forbidden', 'personal workspaces cannot have members');
      const u = (await q.query('SELECT id FROM users WHERE email = $1 AND email_verified', [email.trim().toLowerCase()])).rows[0];
      if (!u) throw new DomainError('not_found', 'no account with that confirmed email has signed in yet');
      const ins = await q.query('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
        orgId,
        u.id,
        role,
        this.#clock.now(),
      ]);
      if (!ins.rowCount) throw new DomainError('conflict', 'already a member');
      audit.push({ actor: { type: 'user', id: p.userId }, action: 'member.added', target: { type: 'user', id: u.id }, orgId, metadata: { role } });
      return { userId: u.id as string, role };
    });
  }
}
