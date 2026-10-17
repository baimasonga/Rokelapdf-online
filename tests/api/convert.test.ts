import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '@/lib/server/kernel';
import { HttpConverter, attachment, matchesType, outputName, readBody, type ConvertTarget, type Converter } from '@/lib/server/convert';
import { pdf, sharingEnv, type SharingEnv } from './support';

// Office conversions: signed-in, verified users only; per-user limits; type and size checks before anything is
// forwarded; results returned directly and never stored.

let env: SharingEnv;
afterEach(async () => env?.close());

class FakeConverter implements Converter {
  readonly calls: Array<{ target: ConvertTarget; from: string; bytes: Uint8Array }> = [];
  fail: DomainError | undefined;
  async convert(target: ConvertTarget, from: string, bytes: Uint8Array) {
    this.calls.push({ target, from, bytes });
    if (this.fail) throw this.fail;
    return new TextEncoder().encode(`converted:${target}:${bytes.length}`);
  }
}

const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const post = (env: SharingEnv, target: string, name: string, raw: Uint8Array, token?: string) =>
  env.call('POST', `/api/v1/convert/${target}?name=${encodeURIComponent(name)}`, { ...(token ? { token } : {}), raw });

describe('office conversion: access', () => {
  it('is off until a converter is configured, and the public config says so', async () => {
    env = await sharingEnv();
    expect((await env.call('GET', '/api/v1/config')).body.convert).toBe(false);
    const u = await env.user('a@example.test', { verified: true });
    const r = await post(env, 'docx', 'a.pdf', pdf('x'), u.token);
    expect([r.status, r.body.code]).toEqual([503, 'unavailable']);
  });

  it('requires a signed-in user with a confirmed email address', async () => {
    const conv = new FakeConverter();
    env = await sharingEnv({ converter: conv });
    expect((await env.call('GET', '/api/v1/config')).body.convert).toBe(true);
    expect((await post(env, 'docx', 'a.pdf', pdf('x'))).status).toBe(401);
    expect((await post(env, 'docx', 'a.pdf', pdf('x'), 'not-a-real-token')).status).toBe(401);
    const unverified = await env.user('new@example.test');
    const r = await post(env, 'docx', 'a.pdf', pdf('x'), unverified.token);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(conv.calls).toHaveLength(0);
  });
});

describe('office conversion: requests', () => {
  it('forwards the file and returns the result as a download with a safe name', async () => {
    const conv = new FakeConverter();
    env = await sharingEnv({ converter: conv });
    const u = await env.user('a@example.test', { verified: true });
    const input = pdf('quarterly report');
    const r = await post(env, 'docx', 'Report "Q3"/final.PDF', input, u.token);
    expect(r.status).toBe(200);
    expect(r.text).toBe(`converted:docx:${input.length}`);
    expect(r.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="Report Q3 final.docx"; filename*=UTF-8''Report%20Q3%20final.docx`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(conv.calls).toEqual([{ target: 'docx', from: 'pdf', bytes: new Uint8Array(input) }]);

    const back = await post(env, 'pdf', 'slides.pptx', DOCX, u.token);
    expect([back.status, back.headers.get('content-type')]).toEqual([200, 'application/pdf']);
    expect(conv.calls[1]).toMatchObject({ target: 'pdf', from: 'pptx' });
  });

  it('refuses unknown conversions, wrong file types and files whose bytes do not match their name', async () => {
    const conv = new FakeConverter();
    env = await sharingEnv({ converter: conv });
    const u = await env.user('a@example.test', { verified: true });
    expect((await post(env, 'exe', 'a.pdf', pdf('x'), u.token)).status).toBe(404);
    expect((await post(env, 'docx', 'a.docx', DOCX, u.token)).status).toBe(400); // Word → Word
    expect((await post(env, 'pdf', 'a.pdf', pdf('x'), u.token)).status).toBe(400); // PDF → PDF
    expect((await post(env, 'pdf', 'page.html', new TextEncoder().encode('<html>'), u.token)).status).toBe(400);
    expect((await post(env, 'docx', 'fake.pdf', DOCX, u.token)).status).toBe(400); // a ZIP named .pdf
    expect((await post(env, 'pdf', 'fake.docx', pdf('x'), u.token)).status).toBe(400); // a PDF named .docx
    expect((await post(env, 'pdf', 'old.doc', DOCX, u.token)).status).toBe(400); // legacy .doc must be OLE
    expect((await post(env, 'docx', 'empty.pdf', new Uint8Array(), u.token)).status).toBe(400);
    const extra = await env.call('POST', `/api/v1/convert/docx?name=a.pdf&debug=1`, { token: u.token, raw: pdf('x') });
    expect(extra.status).toBe(400); // unknown query fields are rejected
    expect(conv.calls).toHaveLength(0);
  });

  it('enforces the size limit while reading, before anything is forwarded', async () => {
    const conv = new FakeConverter();
    env = await sharingEnv({ converter: conv, conversionLimits: { maxBytes: 64 } });
    const u = await env.user('a@example.test', { verified: true });
    const big = new Uint8Array(65).fill(0x41);
    big.set(new TextEncoder().encode('%PDF-1.7'));
    const r = await post(env, 'docx', 'big.pdf', big, u.token);
    expect([r.status, r.body.code]).toEqual([413, 'too_large']);
    expect((await post(env, 'docx', 'ok.pdf', big.subarray(0, 64), u.token)).status).toBe(200);
    expect(conv.calls).toHaveLength(1);
  });

  it('limits each user per minute and per day, independently of other users', async () => {
    const conv = new FakeConverter();
    env = await sharingEnv({ converter: conv, conversionLimits: { perMinute: 2, perDay: 3 } });
    const a = await env.user('a@example.test', { verified: true });
    const b = await env.user('b@example.test', { verified: true });
    expect((await post(env, 'docx', 'a.pdf', pdf('1'), a.token)).status).toBe(200);
    expect((await post(env, 'docx', 'a.pdf', pdf('2'), a.token)).status).toBe(200);
    const third = await post(env, 'docx', 'a.pdf', pdf('3'), a.token);
    expect([third.status, third.body.code]).toEqual([429, 'rate_limited']);
    expect((await post(env, 'docx', 'b.pdf', pdf('1'), b.token)).status).toBe(200);
    env.clock.advance(61_000);
    // Minute window passed, but the third attempt counted against the day: one more is refused for the day.
    const day = await post(env, 'docx', 'a.pdf', pdf('4'), a.token);
    expect([day.status, day.body.message]).toEqual([429, "You have reached today's limit of 3 conversions. Try again tomorrow."]);
    expect(conv.calls).toHaveLength(3);
  });

  it('passes on the converter’s message for a file it cannot convert', async () => {
    const conv = new FakeConverter();
    conv.fail = new DomainError('unprocessable', 'This PDF is password-protected. Unlock it first, then convert it.');
    env = await sharingEnv({ converter: conv });
    const u = await env.user('a@example.test', { verified: true });
    const r = await post(env, 'xlsx', 'locked.pdf', pdf('x'), u.token);
    expect([r.status, r.body.message]).toEqual([422, 'This PDF is password-protected. Unlock it first, then convert it.']);
  });
});

describe('the converter client', () => {
  const ok = (body: BodyInit, status = 200, type = 'application/octet-stream') => new Response(body, { status, headers: { 'content-type': type } });

  it('authenticates with the shared token, names the conversion and refuses redirects', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const c = new HttpConverter({
      url: 'http://converter.railway.internal:8080',
      token: 'k'.repeat(40),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return ok(new Uint8Array([1, 2, 3]));
      }) as unknown as typeof fetch,
    });
    expect(await c.convert('pptx', 'pdf', new Uint8Array([9]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]!.url).toBe('http://converter.railway.internal:8080/v1/convert/pptx?from=pdf');
    expect(seen[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${'k'.repeat(40)}` } });
  });

  it('maps converter failures to clear errors and never echoes unexpected bodies', async () => {
    const make = (res: () => Response | Promise<Response>) =>
      new HttpConverter({ url: 'https://c.example', token: 'k'.repeat(40), fetch: (async () => res()) as unknown as typeof fetch });
    const json = (status: number, body: unknown) => ok(JSON.stringify(body), status, 'application/json');
    const err = async (c: HttpConverter) => (await c.convert('docx', 'pdf', new Uint8Array([1])).catch((e: DomainError) => e)) as DomainError;

    expect(await err(make(() => json(422, { code: 'unconvertible', message: 'This PDF has no pages.' })))).toMatchObject({
      code: 'unprocessable',
      message: 'This PDF has no pages.',
    });
    const internal = await err(make(() => json(500, { message: 'Traceback: secret document text' })));
    expect(internal.code).toBe('unavailable');
    expect(internal.message).not.toContain('secret');
    expect((await err(make(() => json(401, { code: 'unauthorized' })))).code).toBe('unavailable');
    expect((await err(make(() => json(429, { code: 'busy' })))).code).toBe('unavailable');
    expect((await err(make(() => json(504, { code: 'timeout' })))).code).toBe('unprocessable');
    expect((await err(make(() => json(413, { message: 'Files up to 50 MB can be converted.' })))).code).toBe('too_large');
    expect(
      (
        await err(
          make(() => {
            throw new TypeError('fetch failed');
          }),
        )
      ).code,
    ).toBe('unavailable');
  });
});

describe('conversion helpers', () => {
  it('stops reading a request body as soon as it passes the limit (an endless upload is not buffered)', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request('http://x/', { method: 'POST', body: endless, duplex: 'half' } as RequestInit);
    await expect(readBody(req, 4500, () => new Error('too big'))).rejects.toThrow('too big');
    expect(pulled).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
    const small = await readBody(new Request('http://x/', { method: 'POST', body: new Uint8Array([1, 2, 3]) }), 3, () => new Error('x'));
    expect(small).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('builds safe download names and headers', () => {
    expect(outputName('Report.pdf', 'docx')).toBe('Report.docx');
    expect(outputName('../../etc/passwd.pdf', 'xlsx')).toBe('.. .. etc passwd.xlsx');
    expect(outputName('\u0000\r\n.pdf', 'pptx')).toBe('document.pptx');
    expect(outputName('Facture – été.docx', 'pdf')).toBe('Facture – été.pdf');
    expect(attachment('Facture – été.pdf')).toBe(`attachment; filename="Facture _ _t_.pdf"; filename*=UTF-8''Facture%20%E2%80%93%20%C3%A9t%C3%A9.pdf`);
  });

  it('recognises each source type by its first bytes', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(matchesType('pdf', pdf('x'))).toBe(true);
    expect(matchesType('docx', DOCX) && matchesType('odp', DOCX)).toBe(true);
    expect(matchesType('xls', ole)).toBe(true);
    expect(matchesType('rtf', new TextEncoder().encode('{\\rtf1 hi}'))).toBe(true);
    expect(matchesType('doc', DOCX) || matchesType('docx', ole) || matchesType('pdf', DOCX) || matchesType('exe', DOCX)).toBe(false);
  });
});
