import { describe, expect, it } from 'vitest';
import { buildCsp, cspInputsFromEnv, pageSecurityHeaders } from '@/lib/csp';

const dir = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('page content security policy', () => {
  const prod = buildCsp({
    nonce: 'abc123',
    devServer: false,
    https: true,
    supabaseUrl: 'https://proj.supabase.co/',
    storageOrigin: 'https://acct.r2.cloudflarestorage.com',
  });

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
    const c = buildCsp({ nonce: 'n', devServer: false, https: true, supabaseUrl: 'javascript:alert(1)', storageOrigin: 'not a url' });
    expect(dir(c, 'connect-src')).toBe("connect-src 'self'");
  });

  it('sends HSTS and upgrades requests only over HTTPS', () => {
    expect(pageSecurityHeaders(false)['strict-transport-security']).toBeUndefined();
    expect(pageSecurityHeaders(true)['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(pageSecurityHeaders(false)['x-frame-options']).toBe('DENY');
    expect(buildCsp({ nonce: 'n', devServer: false, https: false, supabaseUrl: undefined, storageOrigin: undefined })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('derives inputs from the server environment: R2 in production, eval only for next dev', () => {
    const prodEnv = {
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://app.example',
      SUPABASE_URL: 'https://p.supabase.co',
      R2_ENDPOINT: 'https://a.r2.cloudflarestorage.com',
    };
    expect(cspInputsFromEnv(prodEnv, 'n')).toEqual({
      nonce: 'n',
      devServer: false,
      https: true,
      supabaseUrl: 'https://p.supabase.co',
      storageOrigin: 'https://a.r2.cloudflarestorage.com',
    });
    // A production build run locally (APP_ENV=development) keeps the strict script policy.
    const local = cspInputsFromEnv({ NODE_ENV: 'production', APP_ENV: 'development', CONTENT_PORT: '4001' }, 'n');
    expect(local).toMatchObject({ devServer: false, https: false, storageOrigin: 'http://127.0.0.1:4001' });
    expect(dir(buildCsp(local), 'script-src')).not.toContain("'unsafe-eval'");
    expect(cspInputsFromEnv({ NODE_ENV: 'development' }, 'n').devServer).toBe(true);
    expect(cspInputsFromEnv({ NODE_ENV: 'production' }, 'n').storageOrigin).toBeUndefined();
  });
});
