import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/server/config';

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const PROD = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db/x',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  PUBLIC_ORIGIN: 'https://app.rokela.example',
  SHARING_SECRET: 's'.repeat(48),
  STORAGE: 'r2',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_BUCKET: 'rokela-pdf',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  CLAMD_HOST: 'clamav.railway.internal',
};

describe('configuration fails closed in production', () => {
  it('enables the current trial by default, supports an explicit end, and rejects mistyped flags', () => {
    expect(loadConfig(env(PROD)).trialMode).toBe(true);
    expect(loadConfig(env({ ...PROD, TRIAL_MODE: 'false' })).trialMode).toBe(false);
    expect(() => loadConfig(env({ ...PROD, TRIAL_MODE: 'yes' }))).toThrow(/TRIAL_MODE/);
  });
  it('accepts a complete production configuration', () => {
    expect(loadConfig(env(PROD))).toMatchObject({ env: 'production', storage: { kind: 's3', bucket: 'rokela-pdf' }, clamd: { port: 3310 } });
  });
  it('refuses local storage, weak secrets, plain HTTP, missing antivirus and missing Supabase settings', () => {
    expect(() => loadConfig(env({ ...PROD, STORAGE: 'local' }))).toThrow(/STORAGE=r2/);
    expect(() => loadConfig(env({ ...PROD, SHARING_SECRET: 'short' }))).toThrow(/SHARING_SECRET/);
    expect(() => loadConfig(env({ ...PROD, PUBLIC_ORIGIN: 'http://app.rokela.example' }))).toThrow(/HTTPS/);
    expect(() => loadConfig(env({ ...PROD, R2_ENDPOINT: 'https://app.rokela.example' }))).toThrow(/separate origin/);
    const { CLAMD_HOST: _c, ...noAv } = PROD;
    expect(() => loadConfig(env(noAv))).toThrow(/CLAMD_HOST/);
    expect(loadConfig(env({ ...noAv, MALWARE_SCAN_DISABLED: 'true' })).clamd).toBeUndefined();
    const { SUPABASE_PUBLISHABLE_KEY: _k, ...noKey } = PROD;
    expect(() => loadConfig(env(noKey))).toThrow(/SUPABASE_PUBLISHABLE_KEY/);
    const { DATABASE_URL: _d, ...noDb } = PROD;
    expect(() => loadConfig(env(noDb))).toThrow(/DATABASE_URL/);
  });
  it('validates development settings', () => {
    expect(loadConfig(env({ DATABASE_URL: 'postgres://x' })).storage.kind).toBe('local');
    expect(() => loadConfig(env({ DATABASE_URL: 'postgres://x', CONTENT_ORIGIN: 'http://127.0.0.1:3000' }))).toThrow(/content origin/);
    expect(() => loadConfig(env({ DATABASE_URL: 'postgres://x', DB_SCHEMA: 'bad-name' }))).toThrow();
  });
});

describe('email delivery configuration', () => {
  it('is off by default and needs both the API key and a sender address', () => {
    expect(loadConfig(env(PROD)).mail).toBeUndefined();
    expect(loadConfig(env({ ...PROD, RESEND_API_KEY: 're_x', MAIL_FROM: 'Rokela PDF Pro <transfers@rokela.example>' })).mail).toEqual({
      provider: 'resend',
      apiKey: 're_x',
      from: 'Rokela PDF Pro <transfers@rokela.example>',
    });
    expect(() => loadConfig(env({ ...PROD, RESEND_API_KEY: 're_x' }))).toThrow(/MAIL_FROM is required/);
    expect(() => loadConfig(env({ ...PROD, MAIL_FROM: 'transfers@rokela.example' }))).toThrow(/RESEND_API_KEY is required/);
    expect(() => loadConfig(env({ ...PROD, RESEND_API_KEY: 're_x', MAIL_FROM: 'nobody' }))).toThrow(/MAIL_FROM must be an address/);
    expect(() => loadConfig(env({ ...PROD, RESEND_API_KEY: 're_x', MAIL_FROM: 'x <a@b.co>\r\nBcc: c@d.co' }))).toThrow(/MAIL_FROM must be an address/);
  });
});

describe('office converter configuration', () => {
  const TOKEN = 'c'.repeat(40);
  it('is off by default and needs both the URL and a strong token', () => {
    expect(loadConfig(env(PROD)).converter).toBeUndefined();
    expect(loadConfig(env({ ...PROD, CONVERTER_URL: 'https://convert.rokela.example', CONVERTER_TOKEN: TOKEN })).converter).toEqual({
      url: 'https://convert.rokela.example',
      token: TOKEN,
    });
    expect(() => loadConfig(env({ ...PROD, CONVERTER_URL: 'https://convert.rokela.example' }))).toThrow(/CONVERTER_TOKEN/);
    expect(() => loadConfig(env({ ...PROD, CONVERTER_TOKEN: TOKEN }))).toThrow(/CONVERTER_URL/);
    expect(() => loadConfig(env({ ...PROD, CONVERTER_URL: 'https://convert.rokela.example', CONVERTER_TOKEN: 'short' }))).toThrow(/32/);
  });
  it('normalizes Railway private-domain references and surrounding whitespace', () => {
    const at = (url: string) => loadConfig(env({ ...PROD, CONVERTER_URL: url, CONVERTER_TOKEN: TOKEN })).converter?.url;
    expect(at('converter.railway.internal')).toBe('http://converter.railway.internal:8080');
    expect(at('converter.railway.internal:8090')).toBe('http://converter.railway.internal:8090');
    expect(at('  http://converter.railway.internal:8080/  ')).toBe('http://converter.railway.internal:8080');
    for (const invalid of [
      'convert.example.com',
      'converter.railway.internal.evil.example',
      'converter.railway.internal/path',
      'https://convert.example.com?token=secret',
      'https://convert.example.com#fragment',
      '${{converter.RAILWAY_PRIVATE_DOMAIN}}',
      '   ',
    ]) {
      expect(() => at(invalid)).toThrow(/CONVERTER_URL must be an origin, e.g./);
    }
  });
  it('in production allows plain HTTP only on the Railway private network', () => {
    const at = (url: string) => loadConfig(env({ ...PROD, CONVERTER_URL: url, CONVERTER_TOKEN: TOKEN })).converter?.url;
    expect(at('http://converter.railway.internal:8080')).toBe('http://converter.railway.internal:8080');
    expect(() => at('http://convert.rokela.example')).toThrow(/HTTPS or a \*\.railway\.internal/);
    expect(() => at('http://railway.internal.evil.example')).toThrow(/HTTPS/);
    expect(() => at('https://u:p@convert.rokela.example')).toThrow(/origin/);
    expect(() => at('https://convert.rokela.example/path')).toThrow(/origin/);
    expect(() => at('ftp://convert.rokela.example')).toThrow(/origin/);
    expect(loadConfig(env({ DATABASE_URL: 'postgres://x', CONVERTER_URL: 'http://127.0.0.1:8080', CONVERTER_TOKEN: TOKEN })).converter?.url).toBe(
      'http://127.0.0.1:8080',
    );
  });
});

describe('Cloudflare email configuration', () => {
  const cf = {
    ...PROD,
    MAIL_PROVIDER: 'cloudflare',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_EMAIL_API_TOKEN: 'cf_secret',
    MAIL_FROM: 'Rokela <transfers@rokela.example>',
  };
  it('selects Cloudflare without a Resend key and retains explicit provider selection', () => {
    expect(loadConfig(env({ ...PROD, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) })).mail).toBeUndefined();
    expect(loadConfig(env(cf)).mail).toEqual({ provider: 'cloudflare', accountId: 'a'.repeat(32), apiToken: 'cf_secret', from: cf.MAIL_FROM });
    expect(loadConfig(env({ ...cf, RESEND_API_KEY: 'legacy' })).mail?.provider).toBe('cloudflare');
    expect(loadConfig(env({ ...cf, MAIL_PROVIDER: undefined })).mail?.provider).toBe('cloudflare');
  });
  it('rejects incomplete, ambiguous or invalid provider configuration before serving', () => {
    expect(() => loadConfig(env({ ...cf, CLOUDFLARE_ACCOUNT_ID: undefined }))).toThrow(/CLOUDFLARE_ACCOUNT_ID is required/);
    expect(() => loadConfig(env({ ...cf, CLOUDFLARE_EMAIL_API_TOKEN: undefined }))).toThrow(/CLOUDFLARE_EMAIL_API_TOKEN is required/);
    expect(() => loadConfig(env({ ...cf, CLOUDFLARE_ACCOUNT_ID: '../../x' }))).toThrow(/32-character/);
    expect(() => loadConfig(env({ ...cf, MAIL_FROM: undefined }))).toThrow(/MAIL_FROM is required/);
    expect(() => loadConfig(env({ ...cf, MAIL_PROVIDER: 'unknown' }))).toThrow(/MAIL_PROVIDER/);
    expect(() => loadConfig(env({ ...cf, MAIL_PROVIDER: undefined, RESEND_API_KEY: 'legacy' }))).toThrow(/MAIL_PROVIDER is required/);
  });
});
