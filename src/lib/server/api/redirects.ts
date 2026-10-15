import { DomainError } from '../kernel';
import type { Container } from '../container';
import { clientIp } from './router';

const STATE_TEXT: Record<string, string> = {
  revoked: 'This link was revoked.',
  suspended: 'This link is suspended.',
  expired: 'This link has expired.',
};

function page(status: number, title: string, text: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 16px"><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer' } },
  );
}

/** Short-link resolution with rate limiting; never fetches the destination. */
export async function publicRedirect(c: Container, req: Request, kind: 'public' | 'confidential', code: string): Promise<Response> {
  try {
    if (!(await c.rateLimiter.hit(`ip:${clientIp(req, c.config.trustProxy)}:short`, c.config.rateLimitPerMinute * 5)))
      return page(429, 'Too many requests', 'Please try again in a minute.');
    const ctx = { userAgent: req.headers.get('user-agent') ?? undefined, referer: req.headers.get('referer') ?? undefined };
    let location: string;
    if (kind === 'confidential') location = (await c.sharing.resolveConfidential(code, ctx)).location;
    else {
      const r = await c.sharing.resolveShortLink(req.headers.get('host') ?? new URL(req.url).host, code, ctx);
      location = 'location' in r ? r.location : `${c.config.publicOrigin}/unlock/${encodeURIComponent(code)}`;
    }
    return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'link_unavailable')
      return page(410, 'Link unavailable', STATE_TEXT[String(e.details?.['state'])] ?? 'This link is not available.');
    if (e instanceof DomainError) return page(404, 'Link not found', 'Check that you copied the whole link.');
    throw e;
  }
}
