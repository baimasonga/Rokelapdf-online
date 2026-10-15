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
