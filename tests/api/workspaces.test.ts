import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';

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

  it('team workspaces: owners add members; roles cannot be escalated; personal spaces stay single-user', async () => {
    env = await makeEnv();
    const owner = await env.user('owner@example.test', { verified: true });
    const member = await env.user('member@example.test');
    const outsider = await env.user('outsider@example.test');
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Kamara & Co' } });
    expect(team.status).toBe(201);
    const add = (token: string, email: string, role: string) =>
      env.call('POST', `/api/v1/workspaces/${team.body.id}/members`, { token, body: { email, role } });
    expect((await add(owner.token, 'member@example.test', 'member')).status).toBe(201);
    expect((await add(owner.token, 'member@example.test', 'member')).status).toBe(409);
    expect((await add(member.token, 'outsider@example.test', 'member')).status).toBe(403);
    expect((await add(outsider.token, 'outsider@example.test', 'owner')).status).toBe(404);
    expect((await add(owner.token, 'nobody@example.test', 'member')).status).toBe(404);
    expect(
      (await env.call('POST', `/api/v1/workspaces/${owner.orgId}/members`, { token: owner.token, body: { email: 'member@example.test', role: 'member' } }))
        .status,
    ).toBe(403);
    const members = await env.call('GET', `/api/v1/workspaces/${team.body.id}/members`, { token: member.token });
    expect(members.body.items.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['owner@example.test', 'owner'],
      ['member@example.test', 'member'],
    ]);
    expect((await env.call('GET', `/api/v1/workspaces/${team.body.id}/members`, { token: outsider.token })).status).toBe(404);
    expect((await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'x', admin: true } })).status).toBe(400);
    const audit = await env.audit(team.body.id);
    expect(audit.map((e) => e.action)).toEqual(['org.created', 'member.added']);
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
    env = await makeEnv();
    const r = await env.call('GET', '/api/v1/config');
    expect(Object.keys(r.body).sort()).toEqual(['supabase_publishable_key', 'supabase_url']);
    expect(r.text).not.toContain(env.c.config.sharingSecret);
  });
});
