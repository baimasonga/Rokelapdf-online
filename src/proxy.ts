import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, cspInputsFromEnv, pageSecurityHeaders } from './lib/csp';

/**
 * The host the visitor asked for. Behind Railway (and Cloudflare) the app is reached over plain HTTP on an internal
 * port, so `nextUrl.origin` never equals the public HTTPS origin and comparing it redirected /signin to itself forever.
 * The proxy's Host / X-Forwarded-Host header carries the public host; the scheme is HTTPS at the edge either way.
 */
function requestHost(req: NextRequest): string {
  const raw = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  return raw.split(',')[0]!.trim().toLowerCase();
}

// Next.js proxy: adds a per-request CSP nonce and security headers to HTML pages. API routes and redirects set their own headers.
export function proxy(req: NextRequest) {
  // Keep PKCE requests on the same origin as the email hook and browser storage.
  // Custom short-link domains must remain independent of the account domain.
  if ((process.env.APP_ENV ?? process.env.NODE_ENV) === 'production' && req.nextUrl.pathname === '/signin' && process.env.PUBLIC_ORIGIN) {
    const canonical = new URL(process.env.PUBLIC_ORIGIN);
    if (
      canonical.protocol === 'https:' &&
      !canonical.username &&
      !canonical.password &&
      canonical.pathname === '/' &&
      !canonical.search &&
      !canonical.hash &&
      requestHost(req) !== canonical.host
    ) {
      const destination = new URL('/signin', canonical);
      destination.search = req.nextUrl.search;
      const res = NextResponse.redirect(destination, 307);
      res.headers.set('cache-control', 'no-store');
      res.headers.set('referrer-policy', 'no-referrer');
      return res;
    }
  }
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const inputs = cspInputsFromEnv(process.env, nonce);
  const csp = buildCsp(inputs);
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  for (const [k, v] of Object.entries(pageSecurityHeaders(inputs.https))) res.headers.set(k, v);
  return res;
}

// Proxy (formerly middleware) always runs on the Node.js runtime in Next 16.
export const config = {
  matcher: [{ source: '/((?!api/|l/|d/|_next/static|_next/image|pdfjs/|ocr/|favicon.ico).*)' }],
};
