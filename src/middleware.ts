import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, cspInputsFromEnv, pageSecurityHeaders } from './lib/csp';

// Adds a per-request CSP nonce and security headers to HTML pages. API routes and redirects set their own headers.
export function middleware(req: NextRequest) {
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

export const config = {
  runtime: 'nodejs',
  matcher: [{ source: '/((?!api/|l/|d/|_next/static|_next/image|pdfjs/|favicon.ico).*)' }],
};
