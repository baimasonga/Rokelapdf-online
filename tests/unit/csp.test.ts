import { describe, expect, it } from 'vitest';
import { buildCsp, pageSecurityHeaders } from '@/lib/csp';

const dir = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('page content security policy', () => {
  const prod = buildCsp({ nonce: 'abc123', dev: false, supabaseUrl: 'https://proj.supabase.co/', storageOrigin: 'https://acct.r2.cloudflarestorage.com' });

  it('allows scripts only with the nonce and never unsafe-inline or unsafe-eval in production', () => {
    const s = dir(prod, 'script-src');
    expect(s).toContain("'nonce-abc123'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
  });

  it('limits network access to self, Supabase and the object store', () => {
    expect(dir(prod, 'connect-src')).toBe("connect-src 'self' https://proj.supabase.co https://acct.r2.cloudflarestorage.com");
    expect(dir(prod, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(dir(prod, 'object-src')).toBe("object-src 'none'");
    expect(dir(prod, 'base-uri')).toBe("base-uri 'none'");
    expect(prod).toContain('upgrade-insecure-requests');
  });

  it('drops malformed or non-http origins instead of widening the policy', () => {
    const c = buildCsp({ nonce: 'n', dev: false, supabaseUrl: 'javascript:alert(1)', storageOrigin: 'not a url' });
    expect(dir(c, 'connect-src')).toBe("connect-src 'self'");
  });

  it('sends HSTS only in production', () => {
    // The argument is `dev`.
    expect(pageSecurityHeaders(true)['strict-transport-security']).toBeUndefined();
    expect(pageSecurityHeaders(false)['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(pageSecurityHeaders(false)['x-frame-options']).toBe('DENY');
  });
});
