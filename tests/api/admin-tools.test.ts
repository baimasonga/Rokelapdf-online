import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../support/env';
import { bootstrapOperator, setPlan, validateEntitlements } from '@/lib/server/admin';

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

  it('rejects unknown or mistyped entitlements', () => {
    expect(() => validateEntitlements({ share_persistant: true })).toThrow(/unknown/);
    expect(() => validateEntitlements({ share_persistent: 'yes' })).toThrow(/invalid value/);
    expect(() => validateEntitlements({ share_storage_bytes: -1 })).toThrow(/invalid value/);
    expect(() => validateEntitlements({ share_storage_bytes: 1.5 })).toThrow(/invalid value/);
    expect(() => validateEntitlements([])).toThrow(/object/);
    expect(validateEntitlements({ share_branding: true, share_max_file_bytes: 10 })).toEqual({ share_branding: true, share_max_file_bytes: 10 });
  });
});
