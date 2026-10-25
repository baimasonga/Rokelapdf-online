import { afterEach, describe, expect, it } from 'vitest';
import { FakeMailer, joinTeam, makeEnv, type TestEnv } from '../support/env';

let env: TestEnv;
afterEach(async () => env?.close());

describe('accounts and workspaces', () => {
  it('requires a valid Supabase token and never trusts a malformed one', async () => {
    env = await makeEnv();
    expect((await env.call('GET', '/api/v1/me')).status).toBe(401);
    expect((await env.call('GET', '/api/v1/me', { headers: { authorization: 'Bearer short' } })).status).toBe(401);
    expect((await env.call('GET', '/api/v1/me', { token: 'x'.repeat(40) })).status).toBe(401);
    expect((await env.call('GET', '/api/v1/me', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('creates exactly one personal workspace, even for concurrent first requests', async () => {
    env = await makeEnv();
    const u = await env.user('first@example.test');
    const results = await Promise.all(Array.from({ length: 8 }, () => env.call('GET', '/api/v1/me', { token: u.token })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const me = await env.call('GET', '/api/v1/me', { token: u.token });
    expect(me.body.workspaces.filter((w: { kind: string }) => w.kind === 'personal')).toHaveLength(1);
    expect(me.body.user).toMatchObject({ email: 'first@example.test', email_verified: false });
  });

  it('team workspaces: members join only by accepting; roles cannot be escalated; personal spaces stay single-user', async () => {
    const mailer = new FakeMailer();
    env = await makeEnv({ mailer });
    const owner = await env.user('owner@example.test', { verified: true });
    const member = await env.user('member@example.test', { verified: true });
    const outsider = await env.user('outsider@example.test');
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Kamara & Co' } });
    expect(team.status).toBe(201);
    const W = `/api/v1/workspaces/${team.body.id}`;
    const invite = (token: string, email: string, role: string) => env.call('POST', `${W}/members`, { token, body: { email, role } });
    const memberEmails = async () =>
      (await env.call('GET', `${W}/members`, { token: owner.token })).body.items.map((m: { email: string; role: string }) => [m.email, m.role]);

    // An invitation changes nothing until it is accepted, and answers the same with or without an account.
    const inv = await invite(owner.token, 'Member@Example.test', 'member');
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ email: 'member@example.test', role: 'member', status: 'pending' });
    expect((await invite(owner.token, 'nobody@example.test', 'member')).status).toBe(201);
    expect((await invite(owner.token, 'member@example.test', 'member')).status).toBe(409);
    expect(await memberEmails()).toEqual([['owner@example.test', 'owner']]);
    expect((await env.call('GET', `${W}/members`, { token: member.token })).status).toBe(404);
    expect((await env.call('GET', `${W}/invitations`, { token: owner.token })).body.items.map((i: { email: string }) => i.email)).toEqual([
      'member@example.test',
      'nobody@example.test',
    ]);

    // The email goes out from the job worker.
    await env.c.sharing.processJobs({ limit: 10 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['member@example.test', 'nobody@example.test']);
    expect(mailer.sent[0]!.subject).toContain('Kamara & Co');
    expect(mailer.sent[0]!.html).toContain('Kamara &amp; Co');

    // Only the addressee, signed in with that address confirmed, sees and answers it.
    const mine = await env.call('GET', '/api/v1/me', { token: member.token });
    expect(mine.body.invitations).toEqual([
      expect.objectContaining({ id: inv.body.id, workspace_name: 'Kamara & Co', invited_by: 'owner@example.test', role: 'member' }),
    ]);
    expect((await env.call('GET', '/api/v1/me', { token: outsider.token })).body.invitations).toEqual([]);
    expect((await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: outsider.token, body: {} })).status).toBe(403);
    expect((await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: owner.token, body: {} })).status).toBe(404);
    env.clock.advance(1000);
    const accepted = await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: member.token, body: {} });
    expect(accepted.body.workspace).toEqual({ id: team.body.id, name: 'Kamara & Co', kind: 'team', role: 'member' });
    expect((await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: member.token, body: {} })).status).toBe(404);
    expect(await memberEmails()).toEqual([
      ['owner@example.test', 'owner'],
      ['member@example.test', 'member'],
    ]);
    expect((await invite(owner.token, 'member@example.test', 'member')).status).toBe(409);

    // Roles: members cannot invite, nobody grants above their own role, and non-members get 404.
    expect((await invite(member.token, 'outsider@example.test', 'member')).status).toBe(403);
    expect((await invite(outsider.token, 'outsider@example.test', 'owner')).status).toBe(404);
    expect(
      (await env.call('POST', `/api/v1/workspaces/${owner.orgId}/members`, { token: owner.token, body: { email: 'member@example.test', role: 'member' } }))
        .status,
    ).toBe(403);

    // Declining, cancelling and expiry all end an invitation.
    const declineMe = await env.user('decline@example.test', { verified: true });
    const d = await invite(owner.token, 'decline@example.test', 'admin');
    expect((await env.call('POST', `/api/v1/invitations/${d.body.id}/decline`, { token: declineMe.token, body: {} })).body).toEqual({ declined: true });
    expect((await env.call('POST', `/api/v1/invitations/${d.body.id}/accept`, { token: declineMe.token, body: {} })).status).toBe(404);
    const nobody = (await env.call('GET', `${W}/invitations`, { token: owner.token })).body.items.find(
      (i: { email: string }) => i.email === 'nobody@example.test',
    );
    expect((await env.call('POST', `${W}/invitations/${nobody.id}/cancel`, { token: member.token, body: {} })).status).toBe(403);
    expect((await env.call('POST', `${W}/invitations/${nobody.id}/cancel`, { token: owner.token, body: {} })).body).toEqual({ cancelled: true });
    const later = await invite(owner.token, 'later@example.test', 'member');
    env.clock.advance(8 * 86_400_000);
    const lateUser = await env.user('later@example.test', { verified: true });
    expect((await env.call('GET', '/api/v1/me', { token: lateUser.token })).body.invitations).toEqual([]);
    expect((await env.call('POST', `/api/v1/invitations/${later.body.id}/accept`, { token: lateUser.token, body: {} })).status).toBe(404);
    expect((await invite(owner.token, 'later@example.test', 'member')).status).toBe(201);

    const audit = (await env.audit(team.body.id)).map((e) => e.action);
    expect(audit).toEqual([
      'org.created',
      'member.invited',
      'member.invited',
      'member.added',
      'member.invited',
      'member.invitation_declined',
      'member.invitation_cancelled',
      'member.invited',
      'member.invited',
    ]);
  });

  it('managers change roles and remove members within their rank; a team always keeps an owner', async () => {
    env = await makeEnv();
    const owner = await env.user('own@example.test', { verified: true });
    const admin = await env.user('adm@example.test', { verified: true });
    const member = await env.user('mem@example.test', { verified: true });
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Team' } });
    const W = `/api/v1/workspaces/${team.body.id}`;
    await joinTeam(env, owner.token, team.body.id, admin, 'adm@example.test', 'admin');
    await joinTeam(env, owner.token, team.body.id, member, 'mem@example.test');
    const setRole = (token: string, userId: string, role: string) => env.call('PATCH', `${W}/members/${userId}`, { token, body: { role } });
    const remove = (token: string, userId: string) => env.call('POST', `${W}/members/${userId}/remove`, { token, body: {} });
    const roles = async () =>
      Object.fromEntries(
        (await env.call('GET', `${W}/members`, { token: owner.token })).body.items.map((m: { email: string; role: string }) => [m.email, m.role]),
      );

    // Members cannot manage anyone; admins cannot touch or create owners.
    expect((await setRole(member.token, admin.userId, 'member')).status).toBe(403);
    expect((await remove(member.token, admin.userId)).status).toBe(403);
    expect((await setRole(admin.token, owner.userId, 'member')).status).toBe(403);
    expect((await remove(admin.token, owner.userId)).status).toBe(403);
    expect((await setRole(admin.token, member.userId, 'owner')).status).toBe(403);
    expect((await setRole(admin.token, member.userId, 'admin')).body).toEqual({ user_id: member.userId, role: 'admin' });
    expect((await setRole(admin.token, member.userId, 'member')).status).toBe(200);
    expect((await setRole(owner.token, member.userId, 'superuser')).status).toBe(400);
    expect((await setRole(owner.token, crypto.randomUUID(), 'member')).status).toBe(404);
    const stranger = await env.user('stranger@example.test', { verified: true });
    expect((await setRole(stranger.token, member.userId, 'admin')).status).toBe(404);

    // The last owner can be neither demoted nor removed, and cannot leave; a second owner unlocks it.
    expect((await setRole(owner.token, owner.userId, 'admin')).status).toBe(409);
    expect((await remove(owner.token, owner.userId)).status).toBe(409);
    expect((await setRole(owner.token, admin.userId, 'owner')).status).toBe(200);
    expect((await setRole(owner.token, owner.userId, 'admin')).status).toBe(200);
    expect(await roles()).toEqual({ 'own@example.test': 'admin', 'adm@example.test': 'owner', 'mem@example.test': 'member' });
    // Two owners demoting each other at once still leave one owner.
    await setRole(admin.token, owner.userId, 'owner');
    const both = await Promise.all([setRole(owner.token, admin.userId, 'admin'), setRole(admin.token, owner.userId, 'admin')]);
    // One wins; the other is refused (by then its target is no longer an owner, or is the last one).
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    expect(both.every((r) => [200, 403, 409].includes(r.status))).toBe(true);
    expect(Object.values(await roles()).filter((r) => r === 'owner')).toHaveLength(1);

    // Removal takes effect on the very next request; members may also leave by themselves.
    const owners = Object.entries(await roles()).find(([, r]) => r === 'owner')![0];
    const top = owners === 'own@example.test' ? owner : admin;
    expect((await remove(top.token, member.userId)).body).toEqual({ removed: true });
    expect((await env.call('GET', `${W}/members`, { token: member.token })).status).toBe(404);
    expect((await env.call('GET', `${W}/members`, { token: owner.token === top.token ? admin.token : owner.token })).status).toBe(200);
    const other = top === owner ? admin : owner;
    expect((await remove(other.token, other.userId)).body).toEqual({ removed: true });
    expect((await env.call('GET', '/api/v1/me', { token: other.token })).body.workspaces.map((w: { kind: string }) => w.kind)).toEqual(['personal']);
    // Personal workspaces have no members to manage.
    const personal = `/api/v1/workspaces/${owner.orgId}/members/${owner.userId}`;
    expect((await env.call('POST', `${personal}/remove`, { token: owner.token, body: {} })).status).toBe(403);
    expect((await env.call('PATCH', personal, { token: owner.token, body: { role: 'admin' } })).status).toBe(403);

    const audit = (await env.audit(team.body.id)).map((e) => e.action);
    expect(audit.filter((a) => a === 'member.role_changed')).toHaveLength(6);
    expect(audit.slice(-2)).toEqual(['member.removed', 'member.left']);
  });

  it('an invitation lapses when its sender can no longer grant the role', async () => {
    env = await makeEnv();
    const owner = await env.user('o@example.test', { verified: true });
    const admin = await env.user('admin@example.test', { verified: true });
    const guest = await env.user('guest@example.test', { verified: true });
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Team' } });
    await joinTeam(env, owner.token, team.body.id, admin, 'admin@example.test', 'admin');
    const inv = await env.call('POST', `/api/v1/workspaces/${team.body.id}/members`, {
      token: admin.token,
      body: { email: 'guest@example.test', role: 'admin' },
    });
    expect(inv.status).toBe(201);
    await env.admin.query("UPDATE memberships SET role = 'member' WHERE user_id = $1", [admin.userId]);
    expect((await env.call('POST', `/api/v1/invitations/${inv.body.id}/accept`, { token: guest.token, body: {} })).status).toBe(404);
    expect((await env.call('GET', `/api/v1/workspaces/${team.body.id}/members`, { token: guest.token })).status).toBe(404);
  });

  it('writes the user mirror only when something changed, and repairs it on the next request', async () => {
    env = await makeEnv();
    const u = await env.user('mirror@example.test');
    const row = async () =>
      (await env.admin.query('SELECT email, email_verified, updated_at FROM users WHERE id = $1', [u.userId])).rows[0] as {
        email: string;
        email_verified: boolean;
        updated_at: Date;
      };
    const me = async (token = u.token) => expect((await env.call('GET', '/api/v1/me', { token })).status).toBe(200);
    const first = await row();
    // Repeat requests write nothing while the mirror is current.
    for (const wait of [60_000, 60_000, 10 * 60_000]) {
      env.clock.advance(wait);
      await me();
    }
    expect((await row()).updated_at).toEqual(first.updated_at);
    // Confirming the address and changing it both reach the mirror on the very next request.
    env.verifier.users.set(u.token, { userId: u.userId, email: 'mirror@example.test', emailVerified: true });
    await me();
    expect(await row()).toMatchObject({ email: 'mirror@example.test', email_verified: true });
    env.verifier.users.set(u.token, { userId: u.userId, email: 'renamed@example.test', emailVerified: true });
    await me();
    expect((await row()).email).toBe('renamed@example.test');
    // A mirror changed elsewhere (another instance, a stale token) is repaired on the next request.
    await env.admin.query(`UPDATE users SET email = 'stale@example.test' WHERE id = $1`, [u.userId]);
    await me();
    expect((await row()).email).toBe('renamed@example.test');
    // A personal workspace that went missing is recreated.
    await env.admin.query(`DELETE FROM memberships WHERE user_id = $1`, [u.userId]);
    await me();
    expect((await env.call('GET', '/api/v1/me', { token: u.token })).body.workspaces.map((w: { kind: string }) => w.kind)).toEqual(['personal']);
  });

  it('a re-created account with a known email is not locked out by the stale mirror row', async () => {
    env = await makeEnv();
    const first = await env.user('reuse@example.test', { verified: true });
    // Supabase deletes the account and the same address signs up again with a new user id.
    const token = 'test-token-recreated-account-000000';
    const userId = crypto.randomUUID();
    env.verifier.users.set(token, { userId, email: 'reuse@example.test', emailVerified: true });
    const me = await env.call('GET', '/api/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: userId, email: 'reuse@example.test' });
    const old = await env.admin.query('SELECT email, email_verified FROM users WHERE id = $1', [first.userId]);
    expect(old.rows[0]).toEqual({ email: `released+${first.userId}@invalid`, email_verified: false });
  });

  it('operator routes need the operator flag, which only deployment tooling sets', async () => {
    env = await makeEnv();
    const user = await env.user('user@example.test', { verified: true });
    expect((await env.call('GET', '/api/v1/admin/sharing/abuse-reports', { token: user.token })).status).toBe(403);
    const op = await env.operator('op@example.test');
    expect((await env.call('GET', '/api/v1/admin/sharing/abuse-reports', { token: op })).status).toBe(200);
  });

  it('rate-limits public endpoints per client address', async () => {
    env = await makeEnv({ env: { RATE_LIMIT_PER_MINUTE: '3' } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await env.call('POST', `/api/v1/public/shares/${'a'.repeat(43)}/open`, { body: {} })).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });

  it('serves public client configuration without secrets', async () => {
    const converterToken = 'converter-secret-'.padEnd(48, 'z');
    env = await makeEnv({ env: { CONVERTER_URL: 'http://127.0.0.1:9', CONVERTER_TOKEN: converterToken } });
    const r = await env.call('GET', '/api/v1/config');
    expect(Object.keys(r.body).sort()).toEqual([
      'convert',
      'email',
      'email_sender',
      'paid_features_from',
      'supabase_publishable_key',
      'supabase_url',
      'transfer_types',
    ]);
    expect([r.body.email, r.body.convert]).toEqual([false, true]);
    expect(r.body.email_sender).toBeNull();
    expect(r.text).not.toContain(env.c.config.sharingSecret);
    expect(r.text).not.toContain(converterToken);
    expect(r.text).not.toContain('127.0.0.1:9');
  });
});

describe('health', () => {
  it('reports database reachability without details', async () => {
    env = await makeEnv();
    const ok = await env.call('GET', '/api/v1/health');
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    const broken = { ...env.c, pool: { query: async () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')) } };
    const { buildRouter } = await import('@/lib/server/api/routes');
    const res = await buildRouter().handle(broken as unknown as typeof env.c, new Request('http://127.0.0.1:3000/api/v1/health'));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"ok":false}');
  });
});
