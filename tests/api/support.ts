import { expect } from 'vitest';
import { publicRedirect } from '@/lib/server/api/redirects';
import { makeEnv, type TestEnv } from '../support/env';

export { DAY } from '../support/env';
export const pdf = (text: string) => Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`, 'latin1');
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** Paid plan entitlements that unlock every sharing feature. */
export const BUSINESS = {
  share_storage_bytes: 10 * 1024 ** 3,
  share_persistent: true,
  share_retention_days: 90,
  share_upload_requests: true,
  share_custom_domains: true,
  share_branding: true,
  share_advanced_analytics: true,
};

export type SharingEnv = TestEnv;
export const sharingEnv = (o: Parameters<typeof makeEnv>[0] = {}) => makeEnv(o);
export const sp = (orgId: string) => `/api/v1/workspaces/${orgId}/sharing`;
export const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

/** Resolves /l/:code or /d/:code like the Next.js route handlers do. */
export async function visit(env: TestEnv, path: string, headers: Record<string, string> = {}, host = '127.0.0.1:3000') {
  const [, kind, code] = path.split('/');
  const res = await publicRedirect(env.c, new Request(`http://${host}${path}`, { headers }), kind === 'd' ? 'confidential' : 'public', code!);
  return { status: res.status, location: res.headers.get('location'), headers: res.headers, body: await res.text() };
}

/** Full owner upload: begin → signed part PUTs to the content origin → complete → quarantine jobs. */
export async function upload(env: TestEnv, token: string, orgId: string, body: Record<string, unknown>, bytes: Buffer, opts: { process?: boolean; skipParts?: number[] } = {}) {
  const begin = await env.call('POST', `${sp(orgId)}/uploads`, { token, body: { ...body, size: bytes.length } });
  if (begin.status !== 201) return { begin };
  const id = begin.body.upload_id as string;
  const nums = Array.from({ length: begin.body.part_count as number }, (_, i) => i + 1);
  const signed = await env.call('POST', `${sp(orgId)}/uploads/${id}/parts`, { token, body: { part_numbers: nums } });
  expect(signed.status).toBe(200);
  const size = begin.body.part_size as number;
  for (const p of signed.body.parts as Array<{ part_number: number; url: string }>) {
    if (opts.skipParts?.includes(p.part_number)) continue;
    const chunk = bytes.subarray((p.part_number - 1) * size, p.part_number * size);
    const put = await env.content('PUT', p.url, chunk, { origin: env.c.config.publicOrigin });
    expect(put.status, `part ${p.part_number}`).toBe(200);
  }
  if (opts.skipParts?.length) return { begin, id };
  const complete = await env.call('POST', `${sp(orgId)}/uploads/${id}/complete`, { token, body: {} });
  expect(complete.status).toBe(200);
  if (opts.process !== false) await env.c.sharing.processJobs({ limit: 100 });
  return { begin, id, complete };
}

export const fetchSigned = (env: TestEnv, url: string) => env.content('GET', url);
