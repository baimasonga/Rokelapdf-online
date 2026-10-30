import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { joinTeam } from '../support/env';
import { BUSINESS, DAY, pdf, sharingEnv, sp, tokenOf, type SharingEnv } from './support';
let env: SharingEnv;
afterEach(async () => env?.close());

const BANKS = ['Rokel Commercial Bank', 'Sierra Leone Commercial Bank'];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A university finance team with a fee desk, its owner (finance officer) and a member colleague. */
async function desk(entitlements: Record<string, number | boolean> = BUSINESS, extra: Record<string, unknown> = {}) {
  const owner = await env.user('bursar@example.test', { verified: true });
  const member = await env.user('clerk@example.test', { verified: true });
  const t = await env.call('POST', '/api/v1/workspaces', { token: owner.token, body: { name: 'University of Example' } });
  const orgId = t.body.id as string;
  await joinTeam(env, owner.token, orgId, member, 'clerk@example.test');
  await env.plan(orgId, entitlements);
  const P = sp(orgId);
  const body = {
    title: '2026/27 first semester tuition',
    deadline: new Date(env.clock.now().getTime() + 30 * DAY).toISOString(),
    banks: BANKS,
    currency: 'NLe',
    amount_due: '1500',
    ...extra,
  };
  const created = await env.call('POST', `${P}/fee-desks`, { token: owner.token, body });
  return { owner, member, orgId, P, created, body };
}

async function student(R: string, name: string, payment: Record<string, string>, opts: { receipt?: boolean; submit?: boolean } = {}) {
  const opened = await env.call('POST', `${R}/open`, { body: {} });
  const start = await env.call('POST', `${R}/submissions`, { body: { grant: opened.body.grant, name, payment } });
  if (start.status !== 201) return { start };
  const h = { 'x-submission-secret': start.body.submission_secret as string };
  if (opts.receipt !== false) {
    const bytes = pdf(`receipt of ${name}`);
    const begin = await env.call('POST', `${R}/uploads`, { headers: h, body: { requirement_key: 'receipt', name: 'receipt.pdf', size: bytes.length } });
    expect(begin.status).toBe(201);
    const nums = Array.from({ length: begin.body.part_count as number }, (_, i) => i + 1);
    const parts = await env.call('POST', `${R}/uploads/${begin.body.upload_id}/parts`, { headers: h, body: { part_numbers: nums } });
    const size = begin.body.part_size as number;
    for (const p of parts.body.parts as Array<{ part_number: number; url: string }>)
      expect((await env.content('PUT', p.url, bytes.subarray((p.part_number - 1) * size, p.part_number * size))).status).toBe(200);
    expect((await env.call('POST', `${R}/uploads/${begin.body.upload_id}/complete`, { headers: h, body: {} })).status).toBe(200);
    await env.c.sharing.processJobs({ limit: 100 });
  }
  if (opts.submit === false) return { start, h };
  const submit = await env.call('POST', `${R}/submission/submit`, { headers: h, body: {} });
  const secret = submit.body.fee_status_url ? new URL(submit.body.fee_status_url).hash.slice(1) : undefined;
  return { start, h, submit, secret };
}

const pay = (o: Partial<Record<'payer_id' | 'bank' | 'reference' | 'amount' | 'paid_on', string>> = {}) => ({
  payer_id: 'FBC/2024/123',
  bank: BANKS[0]!,
  reference: 'FT26281ABC12',
  amount: '1,500.00',
  paid_on: '2026-02-20',
  ...o,
});
const status = (secret: string) => env.call('GET', '/api/v1/public/fee-claims/status', { headers: { 'x-claim-secret': secret } });
const line = (o: Partial<{ date: string; amount: number; reference: string; description: string }> = {}) => ({
  date: '2026-02-21',
  amount: 150_000,
  reference: 'FT26281ABC12',
  description: 'TUITION FBC/2024/123 AMINATA KAMARA',
  ...o,
});

describe('receipt processing', () => {
  it('takes claims, matches the bank statement and issues certificates the student can download and anyone can check', async () => {
    env = await sharingEnv();
    const d = await desk();
    expect(d.created.status).toBe(201);
    expect(d.created.body).toMatchObject({ institution: 'University of Example', banks: BANKS, currency: 'NLe', amount_due: 150_000, date_tolerance_days: 3 });
    const deskId = d.created.body.id as string;
    const R = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;

    const opened = await env.call('POST', `${R}/open`, { body: {} });
    expect(opened.body.fee_desk).toEqual({
      institution: 'University of Example',
      payer_id_label: 'Student ID',
      certificate_title: 'Fee clearance certificate',
      banks: BANKS,
      currency: 'NLe',
      amount_due: 150_000,
    });
    expect(opened.body.requirements).toEqual([expect.objectContaining({ key: 'receipt', required: true })]);
    // A fee desk needs the payment; a plain request refuses one.
    expect((await env.call('POST', `${R}/submissions`, { body: { grant: opened.body.grant, name: 'No payment' } })).status).toBe(400);
    expect(
      (await env.call('POST', `${R}/submissions`, { body: { grant: opened.body.grant, name: 'Bad bank', payment: pay({ bank: 'Elsewhere Bank' }) } })).body
        .message,
    ).toMatch(/listed banks/);
    expect(
      (await env.call('POST', `${R}/submissions`, { body: { grant: opened.body.grant, name: 'Future', payment: pay({ paid_on: '2027-01-01' }) } })).body
        .message,
    ).toMatch(/future/);

    // Unsent claims do not hold the reference: an abandoned page does not lock the student out.
    await student(R, 'Aminata Kamara', pay(), { submit: false });
    const a = await student(R, 'Aminata Kamara', pay());
    expect(a.submit!.status).toBe(200);
    expect(a.submit!.body.fee_status_url).toMatch(new RegExp(`^${env.c.config.publicOrigin}/fees/status#fcs_[A-Za-z0-9_-]{43}$`));
    expect((await status(a.secret!)).body).toMatchObject({ status: 'submitted', amount: 'NLe 1,500.00', payer_id: 'FBC/2024/123', certificate: null });
    // The same bank payment, written differently, cannot be claimed again.
    const copy = await student(R, 'Someone Else', pay({ payer_id: 'FBC/2024/999', reference: 'ft-26281 abc12' }));
    expect(copy.start.status).toBe(409);
    expect(copy.start.body.message).toMatch(/already been submitted/);
    const b = await student(R, 'Ibrahim Sesay', pay({ payer_id: 'FBC/2024/456', reference: 'FT26281XYZ99', amount: '1500' }));
    const c = await student(R, 'Fatmata Conteh', pay({ payer_id: 'FBC/2024/789', bank: BANKS[1]!, reference: 'SL778899', amount: '1500' }));
    expect(c.submit!.status).toBe(200);

    const view = await env.call('GET', `${d.P}/fee-desks/${deskId}`, { token: d.owner.token });
    expect(view.body.counts).toEqual({ submitted: 3, matched: 0, cleared: 0, rejected: 0 });
    expect(view.body.claims).toHaveLength(3);
    expect(view.body.claims[0].receipts).toEqual([expect.objectContaining({ name: 'receipt.pdf', status: 'available' })]);
    // A member who did not create the desk sees that it exists, not the students' payments.
    const peek = await env.call('GET', `${d.P}/fee-desks/${deskId}`, { token: d.member.token });
    expect(peek.body).toMatchObject({ claims_visible: false, claims: [] });

    const statement = {
      bank: BANKS[0],
      file_name: 'rcb-february.csv',
      file_sha256: 'b'.repeat(64),
      lines: [line(), line({ reference: 'FT26281XYZ99', amount: 140_000, description: 'TUITION' }), line({ reference: 'UNRELATED1', description: 'SALARY' })],
    };
    expect((await env.call('POST', `${d.P}/fee-desks/${deskId}/statements`, { token: d.member.token, body: statement })).status).toBe(403);
    const imported = await env.call('POST', `${d.P}/fee-desks/${deskId}/statements`, { token: d.owner.token, body: statement });
    expect(imported.status).toBe(200);
    const claimOf = (name: string) => view.body.claims.find((x: { payer_name: string }) => x.payer_name === name);
    expect(imported.body).toMatchObject({ lines: 3, matched: [{ claim_id: claimOf('Aminata Kamara').id, payer_id_found: true }], still_open: 1 });
    expect(imported.body.issues).toEqual([{ claim_id: claimOf('Ibrahim Sesay').id, issue: expect.stringMatching(/NLe 1,400.00, not NLe 1,500.00/) }]);
    // Importing the same statement again confirms nothing twice.
    const again = await env.call('POST', `${d.P}/fee-desks/${deskId}/statements`, { token: d.owner.token, body: statement });
    expect(again.body.matched).toEqual([]);

    const certs = await env.call('POST', `${d.P}/fee-desks/${deskId}/certificates`, {
      token: d.owner.token,
      body: { claim_ids: [claimOf('Aminata Kamara').id, claimOf('Ibrahim Sesay').id] },
    });
    expect(certs.status).toBe(200);
    expect(certs.body.issued).toHaveLength(1);
    expect(certs.body.skipped).toEqual([{ claim_id: claimOf('Ibrahim Sesay').id, reason: 'the claim is submitted, not matched' }]);
    const code = certs.body.issued[0].code as string;

    const pub = await env.call('GET', `/api/v1/public/verifications/${code}`);
    expect(pub.body).toMatchObject({
      title: 'Fee clearance certificate — 2026/27 first semester tuition',
      issuer: { name: 'University of Example' },
      status: 'active',
      details: [
        { label: 'Name', value: 'Aminata Kamara' },
        { label: 'Student ID', value: 'FBC/2024/123' },
        { label: 'Amount paid', value: 'NLe 1,500.00' },
        { label: 'Payment date', value: '2026-02-20' },
        { label: 'Payment confirmed', value: 'Against the bank statement' },
      ],
    });
    // The student and finance download the same certificate, byte for byte the registered one.
    const mine = await env.call('GET', '/api/v1/public/fee-claims/certificate', { headers: { 'x-claim-secret': a.secret! } });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('application/pdf');
    const bytes = (await env.c.sharing.feeClaimCertificate(a.secret!)).bytes;
    expect(sha(bytes)).toBe(pub.body.sha256);
    expect(mine.headers.get('content-length')).toBe(String(bytes.byteLength));
    const theirs = await env.call('GET', `${d.P}/fee-claims/${claimOf('Aminata Kamara').id}/certificate`, { token: d.owner.token });
    expect(theirs.status).toBe(200);
    expect(theirs.headers.get('content-disposition')).toMatch(/fee-clearance-certificate-FBC-2024-123\.pdf/);
    expect((await status(a.secret!)).body).toMatchObject({ status: 'cleared', certificate: { code, status: 'active' } });
    // Someone else's status link, or none, reveals nothing.
    expect((await status(c.secret!)).body.payer_name).toBe('Fatmata Conteh');
    expect((await status(`fcs_${'A'.repeat(43)}`)).status).toBe(404);
    expect((await env.call('GET', '/api/v1/public/fee-claims/certificate', { headers: { 'x-claim-secret': b.secret! } })).status).toBe(404);

    // Revoking the certificate shows on the student's page.
    const vd = (await env.call('GET', `${d.P}/verified-documents`, { token: d.owner.token })).body.items[0];
    await env.call('POST', `${d.P}/verified-documents/${vd.id}/revoke`, { token: d.owner.token, body: { reason: 'payment_reversed' } });
    expect((await status(a.secret!)).body.certificate.status).toBe('revoked');

    const actions = (await env.audit(d.orgId)).map((e) => e.action).filter((x) => x.startsWith('fee.'));
    expect(actions).toEqual([
      'fee.desk.created',
      'fee.claim.submitted',
      'fee.claim.submitted',
      'fee.claim.submitted',
      'fee.statement.imported',
      'fee.statement.imported',
      'fee.claim.cleared',
    ]);
  });

  it('lets finance confirm or reject a claim; rejection frees the payment for its real owner', async () => {
    env = await sharingEnv();
    const d = await desk();
    const deskId = d.created.body.id as string;
    const R = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;
    const impostor = await student(R, 'Impostor', pay({ payer_id: 'XXX/1' }));
    const id = (await env.call('GET', `${d.P}/fee-desks/${deskId}`, { token: d.owner.token })).body.claims[0].id as string;
    const real = await student(R, 'Aminata Kamara', pay());
    expect(real.start.status).toBe(409);

    expect((await env.call('POST', `${d.P}/fee-claims/${id}/reject`, { token: d.member.token, body: { reason: 'duplicate' } })).status).toBe(403);
    const rejected = await env.call('POST', `${d.P}/fee-claims/${id}/reject`, {
      token: d.owner.token,
      body: { reason: 'not_on_statement', message: 'Come to the finance office with the original receipt.' },
    });
    expect(rejected.body.status).toBe('rejected');
    expect((await status(impostor.secret!)).body.rejection).toEqual({
      reason: 'not_on_statement',
      text: 'The payment was not found on the bank statement.',
      message: 'Come to the finance office with the original receipt.',
    });
    expect((await env.call('POST', `${d.P}/fee-claims/${id}/approve`, { token: d.owner.token, body: { note: 'checked' } })).status).toBe(409);

    const retry = await student(R, 'Aminata Kamara', pay({ amount: '1000' }));
    expect(retry.submit!.status).toBe(200);
    const claims = (await env.call('GET', `${d.P}/fee-desks/${deskId}`, { token: d.owner.token })).body.claims;
    const realId = claims.find((x: { payer_name: string }) => x.payer_name === 'Aminata Kamara').id;
    const approved = await env.call('POST', `${d.P}/fee-claims/${realId}/approve`, { token: d.owner.token, body: { note: 'Seen in the bank portal' } });
    expect(approved.body).toMatchObject({ status: 'matched', match_method: 'manual', match_note: 'Seen in the bank portal' });
    // Less than the fee due: no certificate.
    const certs = await env.call('POST', `${d.P}/fee-desks/${deskId}/certificates`, { token: d.owner.token, body: { claim_ids: [realId] } });
    expect(certs.body).toEqual({ issued: [], skipped: [{ claim_id: realId, reason: 'NLe 1,000.00 is less than the NLe 1,500.00 due' }] });
    expect((await env.audit(d.orgId, 'fee.claim.approved'))[0]!.reason).toBe('Seen in the bank portal');
  });

  it('serves any payers: a desk can ask only for a name and issue its own kind of certificate', async () => {
    env = await sharingEnv();
    const d = await desk(BUSINESS, {
      title: 'Conference registration',
      payer_id_label: null,
      certificate_title: 'Payment confirmation',
      amount_due: undefined,
    });
    expect(d.created.body).toMatchObject({ payer_id_label: null, certificate_title: 'Payment confirmation', amount_due: null });
    expect(d.created.body.request.instructions).toMatch(/^Enter the details printed on your bank receipt.*payment confirmation is issued\.$/);
    const R = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;
    // An ID sent anyway is not kept: the desk asks only for a name.
    const p = await student(R, 'Mariama Bangura', pay({ payer_id: 'ignored', amount: '250' }));
    expect(p.submit!.status).toBe(200);
    const claim = (await env.call('GET', `${d.P}/fee-desks/${d.created.body.id}`, { token: d.owner.token })).body.claims[0];
    expect(claim).toMatchObject({ payer_name: 'Mariama Bangura', payer_id: null });
    await env.call('POST', `${d.P}/fee-desks/${d.created.body.id}/statements`, {
      token: d.owner.token,
      body: { bank: BANKS[0], file_name: 's.csv', file_sha256: 'c'.repeat(64), lines: [line({ amount: 25_000, description: 'REGISTRATION' })] },
    });
    const certs = await env.call('POST', `${d.P}/fee-desks/${d.created.body.id}/certificates`, { token: d.owner.token, body: { claim_ids: [claim.id] } });
    expect(certs.body.issued).toHaveLength(1);
    const pub = await env.call('GET', `/api/v1/public/verifications/${certs.body.issued[0].code}`);
    expect(pub.body.title).toBe('Payment confirmation — Conference registration');
    expect(pub.body.details.map((x: { label: string }) => x.label)).toEqual(['Name', 'Amount paid', 'Payment date', 'Payment confirmed']);
    const pdfRes = await env.call('GET', '/api/v1/public/fee-claims/certificate', { headers: { 'x-claim-secret': p.secret! } });
    expect(pdfRes.headers.get('content-disposition')).toMatch(/payment-confirmation-Mariama-Bangura\.pdf/);
    expect((await status(p.secret!)).body).toMatchObject({ payer_id_label: null, payer_id: null, certificate_title: 'Payment confirmation' });
  });

  it('gives the payer the same status link again when the answer to sending was lost', async () => {
    env = await sharingEnv();
    const d = await desk();
    const R = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;
    const a = await student(R, 'Aminata Kamara', pay());
    // Sending again: refused, but the submission's state carries the same link.
    expect((await env.call('POST', `${R}/submission/submit`, { headers: a.h!, body: {} })).status).toBe(409);
    const state = await env.call('GET', `${R}/submission`, { headers: a.h! });
    expect(state.body).toMatchObject({ status: 'submitted', fee_status_url: a.submit!.body.fee_status_url });
    expect((await status(a.secret!)).body.payer_name).toBe('Aminata Kamara');
    // An unsent submission has no link yet.
    const draft = await student(R, 'Ibrahim Sesay', pay({ payer_id: 'FBC/2024/456', reference: 'FT99999999' }), { submit: false });
    expect((await env.call('GET', `${R}/submission`, { headers: draft.h! })).body.fee_status_url).toBeUndefined();
  });

  it('never lets one statement line confirm claims on two desks', async () => {
    env = await sharingEnv();
    const d = await desk();
    const second = await env.call('POST', `${d.P}/fee-desks`, { token: d.owner.token, body: { ...d.body, title: 'Hostel fees' } });
    const R1 = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;
    const R2 = `/api/v1/public/upload-requests/${tokenOf(second.body.request.url)}`;
    await student(R1, 'Aminata Kamara', pay({ reference: 'FT12345678' }));
    await student(R2, 'Someone Else', pay({ payer_id: 'FBC/2024/999', reference: 'ABCDEF' }));
    // One credit names both references: it can confirm only one of the claims.
    const body = {
      bank: BANKS[0],
      file_name: 'rcb.csv',
      file_sha256: 'd'.repeat(64),
      lines: [line({ reference: 'FT12345678', description: 'PAYMENT ABCDEF' })],
    };
    const first = await env.call('POST', `${d.P}/fee-desks/${d.created.body.id}/statements`, { token: d.owner.token, body });
    expect(first.body.matched).toHaveLength(1);
    const other = await env.call('POST', `${d.P}/fee-desks/${second.body.id}/statements`, { token: d.owner.token, body });
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ matched: [], still_open: 1 });
  });

  it('runs only from a team workspace that can issue verified documents', async () => {
    env = await sharingEnv();
    const noVerify = await desk({ share_upload_requests: true });
    expect(noVerify.created.status).toBe(403);
    expect(noVerify.created.body.message).toMatch(/verified documents/);
    await env.plan(noVerify.owner.orgId, BUSINESS);
    const personal = await env.call('POST', `${sp(noVerify.owner.orgId)}/fee-desks`, { token: noVerify.owner.token, body: noVerify.body });
    expect(personal.status).toBe(403);
    expect(personal.body.message).toMatch(/team workspace/);
    await env.plan(noVerify.orgId, BUSINESS);
    const bad = await env.call('POST', `${noVerify.P}/fee-desks`, { token: noVerify.owner.token, body: { ...noVerify.body, banks: ['A|B'] } });
    expect(bad.status).toBe(400);
    const outsider = await env.user('outsider@example.test', { verified: true });
    const ok = await env.call('POST', `${noVerify.P}/fee-desks`, { token: noVerify.owner.token, body: noVerify.body });
    expect((await env.call('GET', `${noVerify.P}/fee-desks/${ok.body.id}`, { token: outsider.token })).status).toBe(404);
    expect((await env.call('GET', `${noVerify.P}/fee-desks`, { token: noVerify.member.token })).body.items).toHaveLength(1);
  });

  it('keeps claims as financial records in the database itself', async () => {
    env = await sharingEnv();
    const d = await desk();
    const R = `/api/v1/public/upload-requests/${tokenOf(d.created.body.request.url)}`;
    await student(R, 'Aminata Kamara', pay());
    const id = (await env.call('GET', `${d.P}/fee-desks/${d.created.body.id}`, { token: d.owner.token })).body.claims[0].id as string;
    const q = (sql: string) => env.admin.query(sql, [id]);
    await expect(q('UPDATE fee_claims SET amount = 1 WHERE id = $1')).rejects.toThrow(/immutable/);
    await expect(q("UPDATE fee_claims SET reference = 'OTHER' WHERE id = $1")).rejects.toThrow(/immutable/);
    await expect(q('DELETE FROM fee_claims WHERE id = $1')).rejects.toThrow(/never deleted/);
    await expect(q("UPDATE fee_claims SET status = 'cleared' WHERE id = $1")).rejects.toThrow(/transition|check constraint/);
    await expect(env.admin.query('DELETE FROM fee_desks WHERE id = $1', [d.created.body.id])).rejects.toThrow(/never deleted/);
    // Deleting the upload request deletes the receipts, not the desk or its claims.
    await env.call('POST', `${d.P}/upload-requests/${d.created.body.request.id}/status`, { token: d.owner.token, body: { action: 'delete' } });
    await env.c.sharing.runRetention();
    const kept = await env.call('GET', `${d.P}/fee-desks/${d.created.body.id}`, { token: d.owner.token });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ request: { status: 'purged' }, claims: [expect.objectContaining({ id, receipts: [] })] });
    await env.call('POST', `${d.P}/fee-claims/${id}/reject`, { token: d.owner.token, body: { reason: 'other' } });
    await expect(q("UPDATE fee_claims SET status = 'submitted', active_key = 'x', rejection_reason = NULL WHERE id = $1")).rejects.toThrow(/final/);
  });
});
