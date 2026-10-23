import { afterEach, describe, expect, it } from 'vitest';
import { FakeMailer, joinTeam } from '../support/env';
import { BUSINESS, DAY, UA, pdf, sharingEnv, sp, tokenOf, upload, type SharingEnv } from './support';
let env: SharingEnv;
afterEach(async () => env?.close());

describe('workspace activity and exports', () => {
  it('keeps audit and metadata exports scoped to authorized managers and omits secrets', async () => {
    env = await sharingEnv();
    const owner = await env.user('owner@example.test', { verified: true });
    const outsider = await env.user('other@example.test', { verified: true });
    const path = sp(owner.orgId);
    await env.call('POST', `${path}/short-links`, {
      token: owner.token,
      body: { kind: 'public', destination_type: 'external', destination_url: 'https://example.com/sensitive-campaign', password: 'private-password-123' },
    });
    const audit = await env.call('GET', `/api/v1/workspaces/${owner.orgId}/audit?action=short_link.created`, { token: owner.token });
    expect(audit.status).toBe(200);
    expect(audit.body.items).toHaveLength(1);
    expect((await env.call('GET', `/api/v1/workspaces/${owner.orgId}/audit`, { token: outsider.token })).status).toBe(404);
    expect((await env.call('GET', `/api/v1/workspaces/${owner.orgId}/audit?before=9999999999999999999`, { token: owner.token })).status).toBe(400);
    const result = await env.call('GET', `/api/v1/workspaces/${owner.orgId}/export`, { token: owner.token });
    expect(result.status).toBe(200);
    expect(result.body.data.short_links).toHaveLength(1);
    expect(JSON.stringify(result.body.data)).not.toMatch(/password_hash|private-password-123|token_hash|salt/);
    expect((await env.call('GET', `/api/v1/workspaces/${owner.orgId}/export`, { token: outsider.token })).status).toBe(404);
    const events = await env.audit(owner.orgId);
    expect(events.some((e) => e.action === 'org.metadata.exported')).toBe(true);
  });
  it('does not expose audit data to ordinary team members', async () => {
    env = await sharingEnv();
    const a = await env.user('a@example.test');
    const b = await env.user('b@example.test', { verified: true });
    const team = await env.call('POST', '/api/v1/workspaces', { token: a.token, body: { name: 'Team' } });
    await joinTeam(env, a.token, team.body.id, b, 'b@example.test');
    expect((await env.call('GET', `/api/v1/workspaces/${team.body.id}/audit`, { token: b.token })).status).toBe(403);
    expect((await env.call('GET', `/api/v1/workspaces/${team.body.id}/export`, { token: b.token })).status).toBe(403);
  });
});

describe('email follow-ups', () => {
  it('delivers the reminder before expiry to a recipient who has not downloaded', async () => {
    const mailer = new FakeMailer();
    env = await sharingEnv({ mailer });
    const owner = await env.user('a@example.test', { verified: true });
    const P = sp(owner.orgId);
    const t = await env.call('POST', `${P}/transfers`, { token: owner.token, body: { title: 'Unread files', kind: 'temporary' } });
    await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: t.body.id, name: 'a.pdf' }, pdf('a'));
    const l = await env.call('POST', `${P}/links`, { token: owner.token, body: { target_type: 'transfer', target_id: t.body.id, permission: 'download' } });
    await env.call('POST', `${P}/links/${l.body.id}/email`, { token: owner.token, body: { to: ['recipient@example.test'], remind_before_expiry: true } });
    await env.c.sharing.processJobs({ limit: 100 });
    env.clock.advance(6 * DAY + 1000);
    await env.c.sharing.processJobs({ limit: 100 });
    expect(mailer.sent.filter((m) => m.subject.startsWith('Reminder:'))).toHaveLength(1);
  });
  it('schedules one expiry reminder and a single daily download digest', async () => {
    const mailer = new FakeMailer();
    env = await sharingEnv({ mailer });
    const owner = await env.user('a@example.test', { verified: true });
    const P = sp(owner.orgId);
    const t = await env.call('POST', `${P}/transfers`, { token: owner.token, body: { title: 'Contract', kind: 'temporary' } });
    await upload(env, owner.token, owner.orgId, { target: 'transfer', transfer_id: t.body.id, name: 'a.pdf' }, pdf('a'));
    const l = await env.call('POST', `${P}/links`, {
      token: owner.token,
      body: { target_type: 'transfer', target_id: t.body.id, permission: 'download', notify_on_access: true },
    });
    const sent = await env.call('POST', `${P}/links/${l.body.id}/email`, {
      token: owner.token,
      body: { to: ['recipient@example.test'], remind_before_expiry: true },
    });
    expect(sent.status).toBe(200);
    const jobs = await env.admin.query("SELECT payload,run_after FROM share_jobs WHERE kind='share_email'");
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.filter((j) => j.payload.mode === 'expiry_reminder')).toHaveLength(1);
    await env.c.sharing.processJobs({ limit: 100 });
    expect(mailer.sent).toHaveLength(1);
    const base = `/api/v1/public/shares/${tokenOf(l.body.url)}`;
    const opened = await env.call('POST', `${base}/open`, { body: {}, headers: { 'user-agent': UA } });
    for (let i = 0; i < 2; i++)
      expect((await env.call('POST', `${base}/archive`, { body: { grant: opened.body.grant }, headers: { 'user-agent': UA } })).status).toBe(200);
    const digests = await env.admin.query("SELECT payload FROM share_jobs WHERE kind='notify_email' AND payload->>'digest'='downloads'");
    expect(digests.rows).toHaveLength(1);
    expect(digests.rows[0].payload.count).toBe('2');
    env.clock.advance(DAY + 1000);
    await env.c.sharing.processJobs({ limit: 100 });
    expect(mailer.sent.some((m) => m.subject === 'Your shared files were downloaded')).toBe(true);
    env.clock.advance(6 * DAY);
    await env.c.sharing.processJobs({ limit: 100 });
    expect(mailer.sent.some((m) => m.subject.startsWith('Reminder:'))).toBe(false);
  });
});

describe('signature collection workflow', () => {
  it('requires a plan and published document, then creates a fixed source and PDF-only return request', async () => {
    env = await sharingEnv();
    const owner = await env.user('a@example.test', { verified: true });
    const P = sp(owner.orgId);
    const d = await env.call('POST', `${P}/documents`, { token: owner.token, body: { title: 'Contract' } });
    const body = { document_id: d.body.id, deadline: new Date(env.clock.now().getTime() + 3 * DAY).toISOString() };
    expect((await env.call('POST', `${P}/signature-requests`, { token: owner.token, body })).status).toBe(403);
    await env.plan(owner.orgId, BUSINESS);
    expect((await env.call('POST', `${P}/signature-requests`, { token: owner.token, body })).status).toBe(409);
    await upload(env, owner.token, owner.orgId, { target: 'draft', document_id: d.body.id, name: 'contract.pdf' }, pdf('contract'));
    const version = await env.call('POST', `${P}/documents/${d.body.id}/export`, { token: owner.token, body: {} });
    expect(version.status).toBe(201);
    await env.call('POST', `${P}/documents/${d.body.id}/publish`, { token: owner.token, body: { version_id: version.body.id } });
    const result = await env.call('POST', `${P}/signature-requests`, { token: owner.token, body });
    expect(result.status).toBe(201);
    expect(result.body.version_id).toBe(version.body.id);
    expect(result.body.requirements[0]).toMatchObject({ key: 'signed_pdf', accept: ['pdf'], max_files: 1 });
    const source = await env.call('GET', `${P}/links/${result.body.source_link_id}`, { token: owner.token });
    expect(source.body.version_mode).toBe('fixed');
  });
});
