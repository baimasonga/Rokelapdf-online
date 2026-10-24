import { DomainError, newId, type AuditEventInput, type Clock, type UserPrincipal } from './kernel';
import { UNIQUE_VIOLATION, pgErr, withTransaction, type PgPool, type Queryable } from './db/pg';
import { normalizeEmail } from './sharing/policy';
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
const canGrant = (actor: Role, role: Role) => RANK[role] <= RANK[actor] && (role !== 'owner' || actor === 'owner');
const INVITATION_DAYS = 7;

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: 'pending';
  createdAt: Date;
  expiresAt: Date;
}
export interface ReceivedInvitation {
  id: string;
  role: Role;
  workspaceName: string;
  invitedBy: string;
  expiresAt: Date;
}
const invitationRow = (x: Record<string, unknown>): Invitation => ({
  id: x['id'] as string,
  email: x['email'] as string,
  role: x['role'] as Role,
  status: 'pending',
  createdAt: x['created_at'] as Date,
  expiresAt: x['expires_at'] as Date,
});

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

  /**
   * Upserts the user mirror and creates the personal workspace on first sign-in. Idempotent and race-safe. Runs before
   * every signed-in request, so a read first decides whether anything changed: the write, with its row lock, runs only
   * for a new user, a changed email or confirmation, or a missing personal workspace. The read always reflects the
   * database, so a mirror changed by another instance is repaired on the next request.
   */
  async sync(p: UserPrincipal): Promise<void> {
    const cur = (
      await this.#pool.query(
        `SELECT u.email, u.email_verified, EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id
           WHERE m.user_id = u.id AND o.kind = 'personal') AS has_personal FROM users u WHERE u.id = $1`,
        [p.userId],
      )
    ).rows[0];
    if (!cur || cur.email !== p.email || cur.email_verified !== p.emailVerified || !cur.has_personal) await this.#write(p);
  }

  async #write(p: UserPrincipal): Promise<void> {
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

  /** Members who manage the workspace's sharing settings (owners and admins). */
  async managers(orgId: string): Promise<string[]> {
    const r = await this.#pool.query("SELECT user_id FROM memberships WHERE org_id = $1 AND role IN ('owner','admin') ORDER BY created_at", [orgId]);
    return r.rows.map((x) => x.user_id as string);
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

  /**
   * Changes a member's role. Managers act on members ranked at or below them and grant at most their own role; only
   * an owner changes an owner, and a team always keeps at least one owner.
   */
  async changeRole(p: UserPrincipal, orgId: string, userId: string, role: Role): Promise<{ userId: string; role: Role }> {
    return this.#tx(async (q, audit) => {
      const { actor, target } = await this.#lockMembers(q, p, orgId, userId);
      if (!canGrant(actor, target) || !canGrant(actor, role)) throw new DomainError('forbidden', 'cannot change a role above your own');
      if (target === role) return { userId, role };
      if (target === 'owner') await this.#keepAnOwner(q, orgId);
      await q.query('UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2', [orgId, userId, role]);
      audit.push({
        actor: { type: 'user', id: p.userId },
        action: 'member.role_changed',
        target: { type: 'user', id: userId },
        orgId,
        metadata: { from: target, to: role },
      });
      return { userId, role };
    });
  }

  /**
   * Removes a member, or lets a member leave. Same rank rules as `changeRole`; the last owner can do neither. Items
   * they created stay with the workspace, and invitations they sent stop working (see `respond`).
   */
  async removeMember(p: UserPrincipal, orgId: string, userId: string): Promise<{ removed: true }> {
    return this.#tx(async (q, audit) => {
      const self = userId === p.userId;
      const { actor, target } = await this.#lockMembers(q, p, orgId, userId, self);
      if (!self && !canGrant(actor, target)) throw new DomainError('forbidden', 'cannot remove a member above your own role');
      if (target === 'owner') await this.#keepAnOwner(q, orgId);
      await q.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
      audit.push({
        actor: { type: 'user', id: p.userId },
        action: self ? 'member.left' : 'member.removed',
        target: { type: 'user', id: userId },
        orgId,
        metadata: { role: target },
      });
      return { removed: true as const };
    });
  }

  /**
   * Locks the team's memberships (so concurrent changes cannot remove the last owner) and returns the actor's and the
   * target's roles. Non-members get 404; members without the permission 403 (unless acting on themselves).
   */
  async #lockMembers(q: Queryable, p: UserPrincipal, orgId: string, userId: string, self = false): Promise<{ actor: Role; target: Role }> {
    const rows = (await q.query('SELECT user_id, role FROM memberships WHERE org_id = $1 ORDER BY user_id FOR UPDATE', [orgId])).rows as Array<{
      user_id: string;
      role: Role;
    }>;
    const actor = rows.find((r) => r.user_id === p.userId)?.role;
    if (!actor) throw new DomainError('not_found', 'not found');
    const org = (await q.query('SELECT kind FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (org?.kind !== 'team') throw new DomainError('forbidden', 'personal workspaces cannot have members');
    if (!self && !GRANTS[actor].includes('org:manage_members')) throw new DomainError('forbidden', 'insufficient permissions');
    const target = rows.find((r) => r.user_id === userId)?.role;
    if (!target) throw new DomainError('not_found', 'not a member of this workspace');
    return { actor, target };
  }

  /** Throws unless another owner remains (call with the memberships locked, before demoting or removing an owner). */
  async #keepAnOwner(q: Queryable, orgId: string) {
    const owners = Number((await q.query("SELECT count(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [orgId])).rows[0].n);
    if (owners < 2) throw new DomainError('conflict', 'A team needs at least one owner. Make someone else an owner first.');
  }

  /**
   * Invites an address to a team. Nobody joins until they accept, signed in with that address confirmed; the answer
   * is the same whether or not the address has an account. An actor may invite at most their own role.
   */
  async invite(p: UserPrincipal, orgId: string, email: string, role: Role): Promise<Invitation> {
    const actor = await this.require(p, orgId, 'org:manage_members');
    if (!canGrant(actor, role)) throw new DomainError('forbidden', 'cannot grant a role above your own');
    const addr = normalizeEmail(email);
    try {
      return await this.#tx(async (q, audit) => {
        const org = (await q.query('SELECT kind FROM organizations WHERE id = $1', [orgId])).rows[0];
        if (!org || org.kind === 'personal') throw new DomainError('forbidden', 'personal workspaces cannot have members');
        const member = await q.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2', [orgId, addr]);
        if (member.rowCount) throw new DomainError('conflict', 'already a member');
        const now = this.#clock.now();
        await q.query("UPDATE member_invitations SET status = 'expired' WHERE org_id = $1 AND email = $2 AND status = 'pending' AND expires_at <= $3", [
          orgId,
          addr,
          now,
        ]);
        const inv: Invitation = {
          id: newId('inv'),
          email: addr,
          role,
          status: 'pending',
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITATION_DAYS * 86_400_000),
        };
        await q.query(
          `INSERT INTO member_invitations (id, org_id, email, role, invited_by, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
          [inv.id, orgId, addr, role, p.userId, now, inv.expiresAt],
        );
        // Delivered by the sharing job worker (kind member_invite); the job names only the invitation.
        await q.query(
          `INSERT INTO share_jobs (id, org_id, kind, subject_id, payload, run_after, attempts, created_at) VALUES ($1,$2,'member_invite',$3,'{}',$4,0,$4)`,
          [newId('job'), orgId, inv.id, now],
        );
        audit.push({ actor: { type: 'user', id: p.userId }, action: 'member.invited', target: { type: 'invitation', id: inv.id }, orgId, metadata: { role } });
        return inv;
      });
    } catch (e) {
      if (pgErr(e).code === UNIQUE_VIOLATION) throw new DomainError('conflict', 'an invitation to this address is already pending');
      throw e;
    }
  }

  /** Pending invitations of a team (for its member managers). */
  async invitations(p: UserPrincipal, orgId: string): Promise<Invitation[]> {
    await this.require(p, orgId, 'org:manage_members');
    const r = await this.#pool.query(
      `SELECT id, email, role, status, created_at, expires_at FROM member_invitations
       WHERE org_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at`,
      [orgId, this.#clock.now()],
    );
    return r.rows.map(invitationRow);
  }

  async cancelInvitation(p: UserPrincipal, orgId: string, id: string): Promise<{ cancelled: true }> {
    await this.require(p, orgId, 'org:manage_members');
    return this.#tx(async (q, audit) => {
      const r = await q.query(
        "UPDATE member_invitations SET status = 'cancelled', responded_at = $3 WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id",
        [id, orgId, this.#clock.now()],
      );
      if (!r.rowCount) throw new DomainError('not_found', 'not found');
      audit.push({ actor: { type: 'user', id: p.userId }, action: 'member.invitation_cancelled', target: { type: 'invitation', id }, orgId });
      return { cancelled: true as const };
    });
  }

  /** Invitations waiting for this user. Only a confirmed address can see or answer them. */
  async myInvitations(p: UserPrincipal): Promise<ReceivedInvitation[]> {
    if (!p.emailVerified) return [];
    const r = await this.#pool.query(
      `SELECT i.id, i.role, i.expires_at, o.name AS workspace_name, u.email AS invited_by
       FROM member_invitations i JOIN organizations o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by
       WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > $2 ORDER BY i.created_at`,
      [p.email, this.#clock.now()],
    );
    return r.rows.map((x) => ({ id: x.id, role: x.role, workspaceName: x.workspace_name, invitedBy: x.invited_by, expiresAt: x.expires_at }));
  }

  /** Accepts or declines an invitation addressed to this user's confirmed email. */
  async respond(p: UserPrincipal, id: string, accept: boolean): Promise<{ workspace: Workspace } | { declined: true }> {
    if (!p.emailVerified) throw new DomainError('forbidden', 'Confirm your email address to answer invitations.');
    return this.#tx(async (q, audit) => {
      const now = this.#clock.now();
      const inv = (
        await q.query(
          `SELECT i.org_id, i.role, i.invited_by, o.name, o.kind FROM member_invitations i JOIN organizations o ON o.id = i.org_id
           WHERE i.id = $1 AND i.email = $2 AND i.status = 'pending' AND i.expires_at > $3 FOR UPDATE OF i`,
          [id, p.email, now],
        )
      ).rows[0];
      if (!inv) throw new DomainError('not_found', 'This invitation is no longer available.');
      if (!accept) {
        await q.query("UPDATE member_invitations SET status = 'declined', responded_at = $2 WHERE id = $1", [id, now]);
        audit.push({ actor: { type: 'user', id: p.userId }, action: 'member.invitation_declined', target: { type: 'invitation', id }, orgId: inv.org_id });
        return { declined: true as const };
      }
      // The inviter must still be allowed to grant the role; otherwise a removed admin's invitations would live on.
      const inviter = (await q.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [inv.org_id, inv.invited_by])).rows[0]?.role as
        Role | undefined;
      if (!inviter || !GRANTS[inviter].includes('org:manage_members') || !canGrant(inviter, inv.role)) {
        await q.query("UPDATE member_invitations SET status = 'cancelled', responded_at = $2 WHERE id = $1", [id, now]);
        throw new DomainError('not_found', 'This invitation is no longer available.');
      }
      await q.query('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
        inv.org_id,
        p.userId,
        inv.role,
        now,
      ]);
      await q.query("UPDATE member_invitations SET status = 'accepted', responded_at = $2 WHERE id = $1", [id, now]);
      audit.push({
        actor: { type: 'user', id: p.userId },
        action: 'member.added',
        target: { type: 'user', id: p.userId },
        orgId: inv.org_id,
        metadata: { role: inv.role, invitation: id },
      });
      const role = (await q.query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [inv.org_id, p.userId])).rows[0].role as Role;
      return { workspace: { id: inv.org_id, name: inv.name, kind: inv.kind, role } };
    });
  }

  /** What the invitation email needs; undefined once the invitation is no longer pending. */
  async invitationMail(id: string): Promise<{ email: string; workspaceName: string; invitedBy: string; role: Role; expiresAt: Date } | undefined> {
    const r = await this.#pool.query(
      `SELECT i.email, i.role, i.expires_at, o.name, u.email AS invited_by
       FROM member_invitations i JOIN organizations o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by
       WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > $2`,
      [id, this.#clock.now()],
    );
    const x = r.rows[0];
    return x ? { email: x.email, workspaceName: x.name, invitedBy: x.invited_by, role: x.role, expiresAt: x.expires_at } : undefined;
  }
}
