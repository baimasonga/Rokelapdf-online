import { afterEach, describe, expect, it } from 'vitest';
import { FakeMailer } from '../support/env';
import { UA, fetchSigned, pdf, sharingEnv, sp, tokenOf, upload, type SharingEnv } from './support';

// WeTransfer-style transfers: emailing a personal link to each recipient, and "download all" as one counted download.

let env: SharingEnv;
afterEach(async () => env?.close());

const shares = (token: string) => `/api/v1/public/shares/${token}`;

async function transferWithFiles(env: SharingEnv, owner: { token: string; orgId: string }, names = ['a.pdf', 'b.pdf']) {
  const P = sp(owner.orgId);
  const tr = await env.call('POST', `${P}/transfers`, { token: owner.token, body: { title: 'Project files', kind: 'temporary' } });
  expect(tr.status).toBe(201);
  for (const n of names) await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: tr.body.id, name: n }, pdf(n));
  return tr.body.id as string;
}

async function link(env: SharingEnv, owner: { token: string; orgId: string }, transferId: string, extra: Record<string, unknown> = {}) {
  const l = await env.call('POST', `${sp(owner.orgId)}/links`, {
    token: owner.token,
    body: { target_type: 'transfer', target_id: transferId, permission: 'download', ...extra },
  });
  expect(l.status).toBe(201);
  return l.body as { id: string; url: string };
}

describe('transfers: send by email', () => {
  it('refuses to email when no mail provider is configured, and says so in the public config', async () => {
    env = await sharingEnv();
    expect((await env.call('GET', '/api/v1/config')).body.email).toBe(false);
    const owner = await env.user('sender@example.test', { verified: true });
    const l = await link(env, owner, await transferWithFiles(env, owner));
    const r = await env.call('POST', `${sp(owner.orgId)}/links/${l.id}/email`, { token: owner.token, body: { to: ['x@example.test'] } });
    expect(r.status).toBe(409);
  });

  it('publishes the service sender address without exposing email credentials', async () => {
    env = await sharingEnv({
      mailer: new FakeMailer(),
      env: {
        MAIL_PROVIDER: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_EMAIL_API_TOKEN: 'private-mail-token',
        MAIL_FROM: 'Rokela PDF <transfers@rokela.example>',
      },
    });
    const response = await env.call('GET', '/api/v1/config');
    expect(response.body).toMatchObject({ email: true, email_sender: 'Rokela PDF <transfers@rokela.example>' });
    expect(JSON.stringify(response.body)).not.toContain('private-mail-token');
    expect(response.body).not.toHaveProperty('api_token');
    expect(response.body).not.toHaveProperty('account_id');
  });

  it('emails each recipient the link with the message; the token is derived at send time, never stored in the job', async () => {
    const mailer = new FakeMailer();
    env = await sharingEnv({ mailer });
    expect((await env.call('GET', '/api/v1/config')).body.email).toBe(true);
    const owner = await env.user('sender@example.test', { verified: true });
    const P = sp(owner.orgId);
    const l = await link(env, owner, await transferWithFiles(env, owner), { label: 'ama@example.test', password: 'river-stone-42' });
    const r = await env.call('POST', `${P}/links/${l.id}/email`, {
      token: owner.token,
      body: { to: ['Ama@Example.test', 'ama@example.test', 'kofi@example.test'], message: 'Here are the drawings.\nCall me.' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: 2 });
    const jobs = await env.admin.query(`SELECT payload::text AS p FROM share_jobs WHERE kind = 'share_email'`);
    expect(jobs.rowCount).toBe(2);
    expect(jobs.rows.every((j: { p: string }) => !j.p.includes(tokenOf(l.url)))).toBe(true);
    expect(mailer.sent).toHaveLength(0); // sent by the worker, never inline

    await env.c.sharing.processJobs({ limit: 50 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['ama@example.test', 'kofi@example.test']);
    const m = mailer.sent[0]!;
    expect(m.subject).toBe('sender@example.test sent you Project files');
    expect(m.replyTo).toBe('sender@example.test');
    expect(m.text).toContain('Here are the drawings.\nCall me.');
    expect(m.text).toContain(l.url);
    expect(m.text).toContain('password');
    expect((await env.audit(owner.orgId, 'share.link.emailed'))[0]!.metadata).toEqual({ recipients: 2 });
  });

  it('does not send an email for a link revoked before the worker runs', async () => {
    const mailer = new FakeMailer();
    env = await sharingEnv({ mailer });
    const owner = await env.user('sender@example.test', { verified: true });
    const P = sp(owner.orgId);
    const l = await link(env, owner, await transferWithFiles(env, owner));
    expect((await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: ['x@example.test'] } })).status).toBe(200);
    await env.call('POST', `${P}/links/${l.id}/status`, { token: owner.token, body: { action: 'revoke' } });
    await env.c.sharing.processJobs({ limit: 50 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('requires a confirmed sender address, hides other workspaces’ links, validates addresses and caps monthly volume', async () => {
    const mailer = new FakeMailer();
    env = await sharingEnv({ mailer });
    const owner = await env.user('sender@example.test', { verified: true });
    const P = sp(owner.orgId);
    const l = await link(env, owner, await transferWithFiles(env, owner, ['a.pdf']));
    const unverified = await env.user('new@example.test', { verified: false });
    expect((await env.call('POST', `${sp(unverified.orgId)}/links/${l.id}/email`, { token: unverified.token, body: { to: ['x@example.test'] } })).status).toBe(
      403,
    );
    const other = await env.user('other@example.test', { verified: true });
    expect((await env.call('POST', `${sp(other.orgId)}/links/${l.id}/email`, { token: other.token, body: { to: ['x@example.test'] } })).status).toBe(404);
    expect((await env.call('POST', `${sp(owner.orgId)}/links/${l.id}/email`, { token: other.token, body: { to: ['x@example.test'] } })).status).toBe(404);
    expect((await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: ['not-an-address'] } })).status).toBe(400);
    expect((await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: [], message: 'hi' } })).status).toBe(400);
    expect((await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: ['a@example.test'], bcc: 'x' } })).status).toBe(400);
    const batch = Array.from({ length: 20 }, (_, i) => `r${i}@example.test`);
    for (let i = 0; i < 15; i++) expect((await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: batch } })).status).toBe(200);
    const over = await env.call('POST', `${P}/links/${l.id}/email`, { token: owner.token, body: { to: ['one-more@example.test'] } });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('quota_exceeded');
    expect(await env.admin.query(`SELECT count(*)::int AS n FROM share_jobs WHERE kind = 'share_email'`).then((r) => r.rows[0].n)).toBe(300);
  });
});

describe('transfers: download all', () => {
  it('returns every available file for the browser to zip, counted as ONE download', async () => {
    env = await sharingEnv();
    const owner = await env.user('sender@example.test', { verified: true });
    const l = await link(env, owner, await transferWithFiles(env, owner), { max_downloads: 1, notify_on_access: true });
    const t = tokenOf(l.url);
    const open = await env.call('POST', `${shares(t)}/open`, { body: {}, headers: { 'user-agent': UA } });
    expect(open.status).toBe(200);
    const all = await env.call('POST', `${shares(t)}/archive`, { body: { grant: open.body.grant }, headers: { 'user-agent': UA } });
    expect(all.status).toBe(200);
    expect(all.body.title).toBe('Project files');
    expect(all.body.files.map((f: { name: string }) => f.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    for (const f of all.body.files as Array<{ name: string; url: string }>) {
      const got = await fetchSigned(env, f.url);
      expect(got.status).toBe(200);
      expect(got.body.toString('latin1')).toContain(f.name);
    }
    // The single allowed download is used up: neither another archive nor a single file is served.
    const again = await env.call('POST', `${shares(t)}/archive`, { body: { grant: open.body.grant } });
    expect(again.status).toBe(410);
    expect(again.body.details.state).toBe('download_limit_reached');
    const one = await env.call('POST', `${shares(t)}/files/url`, {
      body: { grant: open.body.grant, file_id: open.body.files[0].id, disposition: 'attachment' },
    });
    expect(one.status).toBe(410);
    const act = await env.call('GET', `${sp(owner.orgId)}/links/${l.id}/activity`, { token: owner.token });
    expect(act.body.events.filter((e: { kind: string }) => e.kind === 'download')).toHaveLength(1);
  });

  it('refuses view-only links, bad grants and document links', async () => {
    env = await sharingEnv();
    const owner = await env.user('sender@example.test', { verified: true });
    const transferId = await transferWithFiles(env, owner, ['a.pdf']);
    const view = await link(env, owner, transferId, { permission: 'view' });
    const vt = tokenOf(view.url);
    const open = await env.call('POST', `${shares(vt)}/open`, { body: {} });
    expect((await env.call('POST', `${shares(vt)}/archive`, { body: { grant: open.body.grant } })).status).toBe(403);
    const dl = await link(env, owner, transferId);
    expect((await env.call('POST', `${shares(tokenOf(dl.url))}/archive`, { body: { grant: open.body.grant } })).status).toBe(401);
    expect((await env.call('POST', `${shares(tokenOf(dl.url))}/archive`, { body: { grant: 'g1.forged.grant' } })).status).toBe(401);
  });
});

describe('transfers: file types', () => {
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(32, 1)]);
  it('accepts common transfer formats by their content and rejects disguised files', async () => {
    env = await sharingEnv();
    const owner = await env.user('sender@example.test', { verified: true });
    const P = sp(owner.orgId);
    const tr = await env.call('POST', `${P}/transfers`, { token: owner.token, body: { title: 'Media', kind: 'temporary' } });
    const files: Array<[string, Buffer]> = [
      ['clip.mp4', ftyp('isom')],
      ['take.mov', ftyp('qt  ')],
      ['song.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 2)])],
      ['voice.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(32, 3)])],
      ['fake.mp4', pdf('not a video')],
      ['fake.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 3)])],
    ];
    for (const [name, bytes] of files) await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: tr.body.id, name }, bytes);
    const got = await env.call('GET', `${P}/transfers/${tr.body.id}`, { token: owner.token });
    const status = Object.fromEntries(got.body.files.map((f: { name: string; status: string }) => [f.name, f.status]));
    expect(status).toMatchObject({ 'clip.mp4': 'available', 'take.mov': 'available', 'song.mp3': 'available', 'voice.wav': 'available' });
    expect(status['fake.mp4']).not.toBe('available');
    expect(status['fake.wav']).not.toBe('available');
    expect(
      (await env.call('POST', `${P}/uploads`, { token: owner.token, body: { target: 'transfer', transfer_id: tr.body.id, name: 'tool.exe', size: 10 } }))
        .status,
    ).toBe(400);
  });
});
