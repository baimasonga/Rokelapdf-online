import { afterEach, describe, expect, it } from 'vitest';
import { BasicContentScanner, type FileScanner } from '@/lib/server/sharing';
import type { OutgoingMail } from '@/lib/server/mail';
import { pdf, sharingEnv, sp, upload, type SharingEnv } from './support';

let env: SharingEnv;
afterEach(async () => env?.close());

describe('background jobs', () => {
  it('a long batch keeps its leases, so a second worker never repeats a job (no duplicate emails)', async () => {
    const sent: string[] = [];
    let other: Promise<unknown> | undefined;
    const mailer = {
      async send(m: OutgoingMail) {
        sent.push(m.to);
        // Each email takes half a lease, so the batch as a whole outlasts the lease taken when it was claimed. While
        // the second one is sent, a second worker on the same database looks for work.
        env.clock.advance(150_000);
        if (sent.length === 2) {
          other = env.c.sharing.processJobs({ limit: 20 });
          await other;
        }
      },
    };
    env = await sharingEnv({ mailer });
    const owner = await env.user('lead@example.test', { verified: true });
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Team' } });
    for (const email of ['a@example.test', 'b@example.test', 'c@example.test'])
      expect((await env.call('POST', `/api/v1/workspaces/${team.body.id}/members`, { token: owner.token, body: { email, role: 'member' } })).status).toBe(201);
    await env.c.sharing.processJobs({ limit: 20 });
    await other;
    expect(sent.sort()).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
  });

  it('a worker without email settings leaves email jobs for one that has them, and stale ones are cleared', async () => {
    env = await sharingEnv(); // no mailer: like a backup instance whose email settings are missing
    const owner = await env.user('lead@example.test', { verified: true });
    const team = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'Team' } });
    expect(
      (await env.call('POST', `/api/v1/workspaces/${team.body.id}/members`, { token: owner.token, body: { email: 'new@example.test', role: 'member' } }))
        .status,
    ).toBe(201);
    const pending = async () =>
      Number((await env.admin.query("SELECT count(*) AS n FROM share_jobs WHERE kind = 'member_invite' AND claim IS NULL")).rows[0].n);
    await env.c.sharing.processJobs({ limit: 20 });
    expect(await pending()).toBe(1); // not marked done without sending
    env.clock.advance(6 * 86_400_000);
    expect((await env.c.sharing.runRetention()).staleEmails).toBe(0);
    env.clock.advance(2 * 86_400_000);
    expect((await env.c.sharing.runRetention()).staleEmails).toBe(1);
    expect(await pending()).toBe(0);
  });

  it('keeps retrying checks while the scanner is unreachable, and fails closed only after a day', async () => {
    let down = true;
    const basic = new BasicContentScanner();
    const scanner: FileScanner = {
      name: 'flaky',
      async scan(input) {
        if (down) throw Object.assign(new Error('clamd closed the connection'), { code: 'ECONNREFUSED' });
        return basic.scan(input);
      },
    };
    env = await sharingEnv({ scanner });
    const owner = await env.user('scan@example.test', { verified: true });
    const P = sp(owner.orgId);
    const tr = await env.call('POST', `${P}/transfers`, { token: owner.token, body: { title: 'Files', kind: 'temporary' } });
    const status = async (id: string) => (await env.call('GET', `${P}/uploads/${id}`, { token: owner.token })).body.status;
    const run = async (hours: number) => {
      for (let t = 0; t < hours * 60; t += 30) {
        env.clock.advance(30 * 60_000);
        await env.c.sharing.processJobs({ limit: 20 });
      }
    };

    // Three hours of outage (well past the old ~30-minute limit): still waiting, then checked once the scanner is back.
    const first = await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: tr.body.id, name: 'a.pdf' }, pdf('one'));
    await run(3);
    expect(await status(first.id!)).toBe('processing');
    down = false;
    await run(1);
    expect(await status(first.id!)).toBe('available');

    // A scanner that stays unreachable for more than a day still fails closed.
    down = true;
    const second = await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: tr.body.id, name: 'b.pdf' }, pdf('two'));
    await run(23);
    expect(await status(second.id!)).toBe('processing');
    await run(2);
    const blob = await env.admin.query('SELECT status, reject_reason FROM share_blobs WHERE id = $1', [second.id]);
    expect(blob.rows[0].reject_reason).toBe('scan_failed');
    expect(['rejected', 'deleting', 'deleted']).toContain(blob.rows[0].status);
  });
});
