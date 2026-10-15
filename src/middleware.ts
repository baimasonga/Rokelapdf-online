import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, pageSecurityHeaders } from './lib/csp';

// Adds a per-request CSP nonce and security headers to HTML pages. API routes and redirects set their own headers.
export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const csp = buildCsp({
    nonce,
    dev,
    supabaseUrl: process.env.SUPABASE_URL ?? (dev ? 'http://127.0.0.1:54321' : undefined),
    storageOrigin:
      process.env.STORAGE === 'local' || (!process.env.STORAGE && dev)
        ? (process.env.CONTENT_ORIGIN ?? `http://127.0.0.1:${process.env.CONTENT_PORT ?? 3001}`)
        : process.env.R2_ENDPOINT,
  });
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  for (const [k, v] of Object.entries(pageSecurityHeaders(dev))) res.headers.set(k, v);
  return res;
}

export const config = {
  runtime: 'nodejs',
  matcher: [{ source: '/((?!api/|l/|d/|_next/static|_next/image|pdfjs/|favicon.ico).*)' }],
};
