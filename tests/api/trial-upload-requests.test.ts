import { afterEach, expect, it } from 'vitest';
import { DAY, sharingEnv, sp, type SharingEnv } from './support';

let env: SharingEnv;
afterEach(async () => env?.close());

it('lets separate personal trial workspaces create requests without a paid plan while retaining isolation and quotas', async () => {
  env = await sharingEnv({ env: { TRIAL_MODE: 'true' } });
  const users = [await env.user('trial-one@example.test', { verified: true }), await env.user('trial-two@example.test', { verified: true })];
  const body = {
    title: 'Trial document collection',
    requirements: [{ key: 'document', label: 'Document', accept: ['pdf'], required: true }],
    deadline: new Date(env.clock.now().getTime() + 7 * DAY).toISOString(),
    max_file_bytes: 1_000_000,
    max_total_bytes: 5_000_000,
  };
  for (const user of users) {
    const subscription = await env.call('GET', `/api/v1/workspaces/${user.orgId}/subscription`, { token: user.token });
    expect(subscription.body).toMatchObject({ plan: 'trial', trial_active: true });
    const overview = await env.call('GET', `${sp(user.orgId)}/overview`, { token: user.token });
    expect(overview.body.limits).toMatchObject({ upload_requests: true, storage_bytes: 2 * 1024 ** 3, max_file_bytes: 250 * 1024 ** 2 });
    expect((await env.call('POST', `${sp(user.orgId)}/upload-requests`, { token: user.token, body })).status).toBe(201);
    expect(
      (
        await env.call('POST', `${sp(user.orgId)}/upload-requests`, {
          token: user.token,
          body: { ...body, max_file_bytes: 251 * 1024 ** 2, max_total_bytes: 251 * 1024 ** 2 },
        })
      ).status,
    ).toBe(409);
  }
  expect((await env.call('POST', `${sp(users[0]!.orgId)}/upload-requests`, { token: users[1]!.token, body })).status).toBe(404);
  expect((await env.call('POST', `${sp(users[0]!.orgId)}/upload-requests`, { body })).status).toBe(401);
});
