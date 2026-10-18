import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/server/config';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
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
