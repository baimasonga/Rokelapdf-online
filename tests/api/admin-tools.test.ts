import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import pg from 'pg';
import { bootstrapOperator, setPlan, validateEntitlements } from '@/lib/server/admin';
import { applyGrants } from '@/lib/server/db/schema';

let env: TestEnv;
afterEach(async () => env?.close());

describe('deployment tooling (owner connection)', () => {
  it('bootstraps the first operator with a mandatory reason and an audit event', async () => {
    env = await makeEnv();
    const u = await env.user('ops@example.test', { verified: true });
    expect((await env.call('GET', '/api/v1/admin/sharing/abuse-reports', { token: u.token })).status).toBe(403);
    await expect(bootstrapOperator(env.admin, { email: 'ops@example.test', reason: '' })).rejects.toThrow(/reason/);
    await expect(bootstrapOperator(env.admin, { email: 'nobody@example.test', reason: 'first operator' })).rejects.toThrow(/no such user/);
    expect(await bootstrapOperator(env.admin, { email: 'OPS@example.test', reason: 'first operator' })).toEqual({ userId: u.userId, changed: true });
    expect(await bootstrapOperator(env.admin, { email: 'ops@example.test', reason: 'again' })).toMatchObject({ changed: false });
    expect((await env.call('GET', '/api/v1/admin/sharing/abuse-reports', { token: u.token })).status).toBe(200);
    const ev = await env.admin.query("SELECT actor_type, reason FROM audit_events WHERE action = 'operator.granted'");
    expect(ev.rows).toEqual([{ actor_type: 'system', reason: 'first operator' }]);
  });

  it('sets a plan only as an operator, validates entitlements, and audits the change', async () => {
    env = await makeEnv();
    const owner = await env.user('owner@example.test', { verified: true });
    await env.user('notops@example.test', { verified: true });
    await env.operator('ops@example.test');
    const base = { orgId: owner.orgId, plan: 'business', entitlements: { share_persistent: true, share_storage_bytes: 5e9 }, reason: 'upgrade' };
    await expect(setPlan(env.admin, { ...base, byEmail: 'notops@example.test' })).rejects.toThrow(/only operators/);
    await expect(setPlan(env.admin, { ...base, byEmail: 'ops@example.test', reason: undefined })).rejects.toThrow(/reason/);
    await expect(setPlan(env.admin, { ...base, byEmail: 'ops@example.test', orgId: 'org_missing' })).rejects.toThrow(/no such workspace/);
    expect((await env.call('GET', `/api/v1/workspaces/${owner.orgId}/sharing/overview`, { token: owner.token })).body.limits.persistent).toBe(false);
    await setPlan(env.admin, { ...base, byEmail: 'ops@example.test' });
    const ov = await env.call('GET', `/api/v1/workspaces/${owner.orgId}/sharing/overview`, { token: owner.token });
    expect(ov.body.limits).toMatchObject({ persistent: true, storage_bytes: 5e9 });
    const [ev] = await env.audit(owner.orgId, 'org.plan.changed');
    expect(ev).toMatchObject({ reason: 'upgrade', actor: { type: 'operator' } });
  });

  it('uses one workspace subscription for PDF, transfers and short links, with authorized access', async () => {
    env = await makeEnv();
    const owner = await env.user('bundle@example.test', { verified: true });
    const outsider = await env.user('outside@example.test', { verified: true });
    await env.operator('ops@example.test');
    const path = `/api/v1/workspaces/${owner.orgId}/subscription`;
    const read = () => env.call('GET', path, { token: owner.token });
    expect((await read()).body).toMatchObject({
      plan: 'free',
      scope: 'workspace',
      billing_mode: 'operator_managed',
      services: ['pdf', 'file_transfer', 'link_shortener'],
    });
    expect((await env.call('GET', path, { token: outsider.token })).status).toBe(404);
    const base = { orgId: owner.orgId, byEmail: 'ops@example.test', reason: 'one plan for all products' };
    await setPlan(env.admin, { ...base, plan: 'business', entitlements: { share_storage_bytes: 5e9, share_custom_domains: true } });
    expect((await read()).body.plan).toBe('business');
    const overview = await env.call('GET', `/api/v1/workspaces/${owner.orgId}/sharing/overview`, { token: owner.token });
    expect(overview.body.limits).toMatchObject({ storage_bytes: 5e9, custom_domains: true, persistent: false });
    await setPlan(env.admin, { ...base, plan: 'free', entitlements: {} });
    expect((await read()).body.plan).toBe('free');
    expect((await env.admin.query('SELECT count(*)::int AS n FROM org_plans WHERE org_id=$1', [owner.orgId])).rows[0].n).toBe(1);
    expect((await env.call('GET', `/api/v1/workspaces/${outsider.orgId}/subscription`, { token: outsider.token })).body.plan).toBe('free');
  });

  it('rejects unknown or mistyped entitlements', () => {
    expect(() => validateEntitlements({ share_persistant: true })).toThrow(/unknown/);
    expect(() => validateEntitlements({ share_persistent: 'yes' })).toThrow(/invalid value/);
    expect(() => validateEntitlements({ share_storage_bytes: -1 })).toThrow(/invalid value/);
    expect(() => validateEntitlements({ share_storage_bytes: 1.5 })).toThrow(/invalid value/);
    expect(() => validateEntitlements([])).toThrow(/object/);
    expect(validateEntitlements({ share_branding: true, share_max_file_bytes: 10 })).toEqual({ share_branding: true, share_max_file_bytes: 10 });
  });
});

describe('database grants', () => {
  it("make the schema the app role's default search path, so a pooled connection without startup options works", async () => {
    env = await makeEnv();
    const schema = (await env.admin.query('SELECT current_schema() AS s')).rows[0].s as string;
    const role = 'rokela_sp_test';
    const owner = new pg.Client({ connectionString: process.env['DATABASE_URL'], options: `-c search_path=${schema}` });
    await owner.connect();
    try {
      if (!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount)
        await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test-only-password'`);
      await applyGrants(owner, schema, role);
      const u = new URL(process.env['DATABASE_URL']!);
      u.username = role;
      u.password = 'test-only-password';
      const app = new pg.Client({ connectionString: u.toString() }); // no startup options
      await app.connect();
      try {
        expect((await app.query('SHOW search_path')).rows[0].search_path).toBe(schema);
        expect((await app.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThanOrEqual(0);
        await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    } finally {
      await owner.end();
    }
  });
});
