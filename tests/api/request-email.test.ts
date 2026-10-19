import { afterEach, expect, it } from 'vitest';
import { FakeMailer } from '../support/env';
import { BUSINESS, DAY, sharingEnv, sp, type SharingEnv } from './support';
let env: SharingEnv;
afterEach(async () => env?.close());
async function setup(mailer?: FakeMailer) {
  env = await sharingEnv(mailer ? { mailer } : {});
  const owner = await env.user('requester@example.test', { verified: true });
  await env.plan(owner.orgId, BUSINESS);
  const P = sp(owner.orgId);
  const r = await env.call('POST', `${P}/upload-requests`, {
    token: owner.token,
    body: {
      title: 'Identity documents',
      requirements: [{ key: 'id', label: 'ID scan', accept: ['pdf'] }],
      deadline: new Date(env.clock.now().getTime() + DAY).toISOString(),
      max_file_bytes: 1000000,
      max_total_bytes: 2000000,
    },
  });
  expect(r.status).toBe(201);
  return { owner, P, request: r.body, email: `${P}/upload-requests/${r.body.id}/email` };
}
it('queues deduplicated request invitations and sends branded upload instructions without storing link tokens in jobs', async () => {
  const mailer = new FakeMailer();
  const s = await setup(mailer);
  const queued = await env.call('POST', s.email, {
    token: s.owner.token,
    body: { to: ['Ama@example.test', 'ama@example.test'], message: 'Please upload your ID.\nThank you.' },
  });
  expect(queued.status).toBe(200);
  expect(queued.body).toEqual({ queued: 1 });
  expect(mailer.sent).toHaveLength(0);
  const jobs = await env.admin.query("SELECT payload FROM share_jobs WHERE kind='share_email'");
  expect(jobs.rows).toHaveLength(1);
  expect(JSON.stringify(jobs.rows)).not.toContain(s.request.url.split('/r/')[1]);
  await env.c.sharing.processJobs();
  expect(mailer.sent).toHaveLength(1);
  expect(mailer.sent[0]).toMatchObject({ to: 'ama@example.test', replyTo: 'requester@example.test' });
  expect(mailer.sent[0]!.text).toContain(s.request.url);
  expect(mailer.sent[0]!.html).toContain('Upload your files');
  expect(mailer.sent[0]!.html).toContain('Please upload your ID.<br>Thank you.');
  expect((await env.audit(s.owner.orgId, 'share.request.emailed'))[0]!.metadata).toEqual({ recipients: 1 });
});
it('does not send invitations after the request closes, and prevents cross-workspace access', async () => {
  const mailer = new FakeMailer();
  const s = await setup(mailer);
  const other = await env.user('other@example.test', { verified: true });
  expect(
    (await env.call('POST', `${sp(other.orgId)}/upload-requests/${s.request.id}/email`, { token: other.token, body: { to: ['a@example.test'] } })).status,
  ).toBe(404);
  await env.call('POST', s.email, { token: s.owner.token, body: { to: ['a@example.test'] } });
  await env.call('POST', `${s.P}/upload-requests/${s.request.id}/status`, { token: s.owner.token, body: { action: 'close' } });
  await env.c.sharing.processJobs();
  expect(mailer.sent).toHaveLength(0);
  expect((await env.call('POST', s.email, { token: s.owner.token, body: { to: ['a@example.test'] } })).status).toBe(410);
});
it('explains unavailable email delivery instead of opening an email app or claiming success', async () => {
  const s = await setup();
  expect((await env.call('POST', s.email, { token: s.owner.token, body: { to: ['a@example.test'] } })).status).toBe(409);
});
