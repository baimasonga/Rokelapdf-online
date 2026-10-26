import { ANDROID_APK_SOURCE } from '@/lib/android';

// Serves the Android APK from rokelapdf.com by streaming it from its GitHub release, for people whose network cannot
// reach GitHub's file servers. The path ends in .apk, a type Cloudflare caches, and the response allows a short shared
// cache, so most downloads come from Cloudflare's edge rather than the app. If GitHub cannot be reached from here, the
// browser is sent to GitHub directly rather than shown an error.

/** How long the headers from GitHub may take. Only the start: a slow phone may take minutes to download the body. */
const HEADERS_TIMEOUT_MS = 30_000;
const PASS_THROUGH = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export async function serveApk(req: Request, fetchImpl: typeof fetch = fetch, source = ANDROID_APK_SOURCE): Promise<Response> {
  const range = req.headers.get('range');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  let upstream: Response | undefined;
  try {
    upstream = await fetchImpl(source, {
      headers: { 'accept-encoding': 'identity', ...(range ? { range } : {}) },
      redirect: 'follow',
      signal: abort.signal,
    });
  } catch {
    upstream = undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!upstream || (upstream.status !== 200 && upstream.status !== 206)) {
    await upstream?.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 302, headers: { location: source, 'cache-control': 'no-store' } });
  }
  const headers = new Headers({
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': 'attachment; filename="rokela-pdf.apk"',
    // A new APK is published after every change; ten minutes at the edge keeps the download fresh enough.
    'cache-control': 'public, max-age=300, s-maxage=600',
    'x-content-type-options': 'nosniff',
  });
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (req.method === 'HEAD') {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
