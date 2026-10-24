import { afterEach, describe, expect, it } from 'vitest';
import { joinTeam } from '../support/env';
import { BUSINESS, sharingEnv, sp, type SharingEnv } from './support';
let env: SharingEnv;
afterEach(async () => env?.close());

const SHA = 'a'.repeat(64);
const pub = (code: string) => env.call('GET', `/api/v1/public/verifications/${code}`);

/** A team workspace with the feature, its owner and a second (member) colleague. */
async function team(entitlements: Record<string, number | boolean> = BUSINESS) {
  const owner = await env.user('registrar@example.test', { verified: true });
  const member = await env.user('clerk@example.test', { verified: true });
  const t = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'University of Example — Finance' } });
  expect(t.status).toBe(201);
  const orgId = t.body.id as string;
  await joinTeam(env, owner.token, orgId, member, 'clerk@example.test');
  await env.plan(orgId, entitlements);
  const path = `${sp(orgId)}/verified-documents`;
  const reserve = (token: string, body: unknown = { title: 'Fee clearance 2026/27', details: [{ label: 'Student ID', value: 'FBC/2024/123' }] }) =>
    env.call('POST', path, { token, body });
  const issue = (token: string, id: string, sha256 = SHA) => env.call('POST', `${path}/${id}/issue`, { token, body: { sha256 } });
  const revoke = (token: string, id: string, reason = 'issued_in_error') => env.call('POST', `${path}/${id}/revoke`, { token, body: { reason } });
  return { owner, member, orgId, path, reserve, issue, revoke };
}

describe('verified documents', () => {
  it('reserves a code, issues the stamped digest and shows only published details publicly', async () => {
    env = await sharingEnv();
    const t = await team();
    const r = await t.reserve(t.member.token);
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^[A-Z2-7]{20}$/);
    expect(r.body.url).toBe(`${env.c.config.publicOrigin}/v/${r.body.code}`);
    expect(r.body.status).toBe('pending');
    // A reservation is not public and is not listed.
    expect((await pub(r.body.code)).status).toBe(404);
    expect((await env.call('GET', t.path, { token: t.owner.token })).body.items).toEqual([]);

    const issued = await t.issue(t.member.token, r.body.id);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ status: 'active', sha256: SHA });

    const view = await pub(r.body.code);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      code: r.body.code,
      title: 'Fee clearance 2026/27',
      details: [{ label: 'Student ID', value: 'FBC/2024/123' }],
      issuer: { name: 'University of Example — Finance', verified_domains: [] },
      status: 'active',
      sha256: SHA,
      issued_at: issued.body.issued_at,
      revoked_at: null,
      revocation_reason: null,
    });
    // Nothing about who issued it or the workspace's internals.
    expect(JSON.stringify(view.body)).not.toMatch(/clerk@|registrar@|org_|vdoc_|created_by/);
    // Codes are normalized: lower case, spaces and hyphens still resolve.
    const spaced = r.body.code.toLowerCase().replace(/(.{5})/g, '$1-');
    expect((await pub(spaced)).status).toBe(200);

    expect((await env.call('GET', t.path, { token: t.owner.token })).body.items.map((x: { id: string }) => x.id)).toEqual([r.body.id]);
    const actions = (await env.audit(t.orgId)).map((e) => e.action).filter((a) => a.startsWith('share.verification.'));
    expect(actions).toEqual(['share.verification.reserved', 'share.verification.issued']);
  });

  it('requires the plan feature and a team workspace', async () => {
    env = await sharingEnv();
    const t = await team({ share_upload_requests: true });
    const refused = await t.reserve(t.owner.token);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/not included in this plan/);
    // Personal workspaces have no meaningful issuer name.
    await env.plan(t.owner.orgId, BUSINESS);
    const personal = await env.call('POST', `${sp(t.owner.orgId)}/verified-documents`, { token: t.owner.token, body: { title: 'Letter', details: [] } });
    expect(personal.status).toBe(403);
    expect(personal.body.message).toMatch(/team workspace/);
  });

  it('rejects malformed requests, oversized details and replaced digests', async () => {
    env = await sharingEnv();
    const t = await team();
    for (const body of [
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'Doc', details: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: 'v' })) },
      { title: 'Doc', details: [{ label: 'x'.repeat(41), value: 'v' }] },
      { title: 'Doc', details: [{ label: 'Label', value: '' }] },
      { title: 'Doc', details: [{ label: 'Label', value: 'v', extra: 1 }] },
      { title: 'Doc', status: 'active' },
      // Labels may not imitate the page's own facts, and must be distinct.
      { title: 'Doc', details: [{ label: 'Issued by', value: 'Ministry of Education' }] },
      { title: 'Doc', details: [{ label: 'STATUS', value: 'Valid' }] },
      { title: 'Doc', details: [{ label: 'Issued-on', value: '1 January 2020' }] },
      {
        title: 'Doc',
        details: [
          { label: 'Name', value: 'A' },
          { label: 'name', value: 'B' },
        ],
      },
    ])
      expect((await t.reserve(t.owner.token, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    const r = await t.reserve(t.owner.token);
    for (const sha of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) expect((await t.issue(t.owner.token, r.body.id, sha)).status).toBe(400);
    expect((await t.issue(t.owner.token, r.body.id)).status).toBe(200);
    const again = await t.issue(t.owner.token, r.body.id, 'b'.repeat(64));
    expect(again.status).toBe(409);
    expect((await pub(r.body.code)).body.sha256).toBe(SHA);
  });

  it('lets only the reserving person issue, and only within an hour', async () => {
    env = await sharingEnv();
    const t = await team();
    const r = await t.reserve(t.member.token);
    expect((await t.issue(t.owner.token, r.body.id)).status).toBe(403);
    env.clock.advance(60 * 60 * 1000 + 1);
    expect((await t.issue(t.member.token, r.body.id)).status).toBe(409);
    expect((await pub(r.body.code)).status).toBe(404);
  });

  it('revokes permanently: the creator or a manager, with a reason shown publicly', async () => {
    env = await sharingEnv();
    const t = await team();
    const mine = await t.reserve(t.owner.token);
    await t.issue(t.owner.token, mine.body.id);
    // A member cannot revoke a colleague's document.
    expect((await t.revoke(t.member.token, mine.body.id)).status).toBe(403);
    expect((await t.revoke(t.owner.token, mine.body.id, 'expired')).status).toBe(400);
    const revoked = await t.revoke(t.owner.token, mine.body.id, 'payment_reversed');
    expect(revoked.status).toBe(200);
    expect((await t.revoke(t.owner.token, mine.body.id)).status).toBe(409);
    const view = await pub(mine.body.code);
    expect(view.body).toMatchObject({ status: 'revoked', revocation_reason: 'payment_reversed', sha256: SHA });
    expect(view.body.revoked_at).toBeTruthy();
    // The member can revoke their own; a manager can revoke anyone's.
    const theirs = await t.reserve(t.member.token);
    await t.issue(t.member.token, theirs.body.id);
    expect((await t.revoke(t.member.token, theirs.body.id, 'superseded')).status).toBe(200);
    const other = await t.reserve(t.member.token);
    await t.issue(t.member.token, other.body.id);
    expect((await t.revoke(t.owner.token, other.body.id, 'fraud_suspected')).status).toBe(200);
    // A pending reservation cannot be revoked (it is not a document yet).
    const pending = await t.reserve(t.member.token);
    expect((await t.revoke(t.owner.token, pending.body.id)).status).toBe(404);
    const reasons = (await env.audit(t.orgId, 'share.verification.revoked')).map((e) => e.metadata.reason);
    expect(reasons).toEqual(['payment_reversed', 'superseded', 'fraud_suspected']);
  });

  it('keeps tenants apart and answers unknown or malformed codes with the same 404', async () => {
    env = await sharingEnv();
    const t = await team();
    const outsider = await env.user('outsider@example.test', { verified: true });
    const r = await t.reserve(t.owner.token);
    await t.issue(t.owner.token, r.body.id);
    const theirs = `${sp(outsider.orgId)}/verified-documents`;
    expect((await env.call('POST', `${theirs}/${r.body.id}/revoke`, { token: outsider.token, body: { reason: 'other' } })).status).toBe(404);
    expect((await env.call('POST', `${t.path}/${r.body.id}/revoke`, { token: outsider.token, body: { reason: 'other' } })).status).toBe(404);
    expect((await env.call('GET', t.path, { token: outsider.token })).status).toBe(404);
    for (const code of ['A'.repeat(20), 'AAAA', '1'.repeat(20), `${r.body.code}A`, '<script>'.padEnd(20, 'A')]) {
      const res = await pub(encodeURIComponent(code));
      expect([400, 404], code).toContain(res.status);
    }
    expect((await pub('A'.repeat(20))).status).toBe(404);
  });

  it('shows the workspace’s DNS-verified domains next to the issuer name', async () => {
    env = await sharingEnv();
    const t = await team();
    const r = await t.reserve(t.owner.token);
    await t.issue(t.owner.token, r.body.id);
    await env.admin.query(
      `INSERT INTO share_domains (id, org_id, hostname, verification_token, status, created_at, verified_at)
       VALUES ('dom_${'1'.repeat(24)}', $1, 'finance.example.edu', $2, 'verified', now(), now()),
              ('dom_${'2'.repeat(24)}', $1, 'pending.example.edu', $2, 'pending', now(), null)`,
      [t.orgId, '0'.repeat(32)],
    );
    expect((await pub(r.body.code)).body.issuer.verified_domains).toEqual(['finance.example.edu']);
  });

  it('enforces evidence rules in the database itself', async () => {
    env = await sharingEnv();
    const t = await team();
    const r = await t.reserve(t.owner.token);
    await t.issue(t.owner.token, r.body.id);
    const q = (sql: string) => env.admin.query(sql, [r.body.id]);
    await expect(q(`UPDATE verified_documents SET sha256 = '${'c'.repeat(64)}' WHERE id = $1`)).rejects.toThrow(/only be revoked/);
    await expect(q(`UPDATE verified_documents SET title = 'Changed' WHERE id = $1`)).rejects.toThrow(/only be revoked/);
    await expect(q(`UPDATE verified_documents SET code = '${'B'.repeat(20)}' WHERE id = $1`)).rejects.toThrow(/immutable/);
    await expect(q('DELETE FROM verified_documents WHERE id = $1')).rejects.toThrow(/never deleted/);
    await t.revoke(t.owner.token, r.body.id);
    await expect(
      q(`UPDATE verified_documents SET status = 'active', revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL WHERE id = $1`),
    ).rejects.toThrow(/final/);
  });
});
