import { describe, expect, it, vi } from 'vitest';
import { serveApk } from '@/lib/server/android-apk';
import { ANDROID_APK_SOURCE } from '@/lib/android';

const apk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const github = (init: ResponseInit & { body?: BodyInit | null } = {}) =>
  vi.fn<typeof fetch>(async () => new Response(init.body === undefined ? apk : init.body, { status: 200, ...init }));

describe('serving the Android APK from rokelapdf.com', () => {
  it('streams the release asset as an APK download that Cloudflare may cache', async () => {
    const fetchImpl = github({ headers: { 'content-length': String(apk.length), etag: '"v37"', 'set-cookie': 'x=1' } });
    const res = await serveApk(new Request('https://www.rokelapdf.com/android/rokela-pdf.apk'), fetchImpl);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(apk);
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rokela-pdf.apk"');
    expect(res.headers.get('cache-control')).toContain('s-maxage=');
    expect(res.headers.get('content-length')).toBe(String(apk.length));
    expect(res.headers.get('etag')).toBe('"v37"');
    expect(res.headers.get('set-cookie')).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ANDROID_APK_SOURCE);
    expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
  });

  it('passes a resumed download through as a partial response', async () => {
    const fetchImpl = github({ status: 206, body: apk.slice(4), headers: { 'content-range': `bytes 4-7/${apk.length}` } });
    const res = await serveApk(new Request('https://www.rokelapdf.com/android/rokela-pdf.apk', { headers: { range: 'bytes=4-' } }), fetchImpl);
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('range')).toBe('bytes=4-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 4-7/${apk.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(apk.slice(4));
  });

  it('answers HEAD without a body', async () => {
    const res = await serveApk(new Request('https://www.rokelapdf.com/android/rokela-pdf.apk', { method: 'HEAD' }), github());
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive');
  });

  it('sends the browser to GitHub when GitHub cannot be reached from the server', async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const missing = github({ status: 404, body: 'Not Found' });
    for (const fetchImpl of [down, missing]) {
      const res = await serveApk(new Request('https://www.rokelapdf.com/android/rokela-pdf.apk'), fetchImpl);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(ANDROID_APK_SOURCE);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
