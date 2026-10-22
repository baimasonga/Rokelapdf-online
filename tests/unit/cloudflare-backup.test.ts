import { describe, expect, it } from 'vitest';
import { containerRequest, runtimeEnvironment } from '../../infra/cloudflare/src/runtime.mjs';

describe('independent Cloudflare container backup', () => {
  it('passes application secrets explicitly and keeps deployment credentials out of the container', () => {
    const settings = runtimeEnvironment({
      DATABASE_URL: 'postgres://synthetic',
      CLOUDFLARE_API_TOKEN: 'deployment-only',
      MAIL_API_TOKEN: 'mail-only',
      ENABLE_BACKUP: 'true',
      CLAMD_HOST: 'old.railway.internal',
      CONVERTER_URL: 'http://old.railway.internal',
      CONVERTER_TOKEN: 'obsolete-token',
    });
    expect(settings).toMatchObject({
      DATABASE_URL: 'postgres://synthetic',
      CLOUDFLARE_EMAIL_API_TOKEN: 'mail-only',
      APP_ENV: 'production',
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
    });
    expect(settings).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(settings).not.toHaveProperty('ENABLE_BACKUP');
    expect(settings).not.toHaveProperty('MALWARE_SCAN_DISABLED');
    expect(settings).not.toHaveProperty('CLAMD_HOST');
    expect(settings).not.toHaveProperty('CONVERTER_URL');
    expect(settings).not.toHaveProperty('CONVERTER_TOKEN');
  });
  it('preserves the canonical account domain and streams requests without fetching Railway', async () => {
    const request = new Request('https://backup.workers.dev/api/convert?target=pdf', {
      method: 'POST',
      body: 'synthetic document',
      headers: { authorization: 'Bearer synthetic', 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': 'attacker', 'x-real-ip': 'attacker' },
    });
    const forwarded = containerRequest(request, 'https://www.rokelapdf.com');
    expect(forwarded.url).toBe('https://www.rokelapdf.com/api/convert?target=pdf');
    expect(forwarded.headers.get('host')).toBe('www.rokelapdf.com');
    expect(forwarded.headers.get('x-forwarded-for')).toBe('192.0.2.1');
    expect(forwarded.headers.get('x-real-ip')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBe('Bearer synthetic');
    expect(await forwarded.text()).toBe('synthetic document');
  });
  it('refuses credential-bearing or non-HTTPS canonical origins', () => {
    for (const origin of ['http://app.example', 'https://user:pass@app.example', 'https://app.example/path', 'https://app.example?x=1'])
      expect(() => containerRequest(new Request('https://backup.workers.dev'), origin)).toThrow('invalid canonical origin');
  });
});
