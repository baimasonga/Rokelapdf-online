import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateHostname } from './sharing';
import { assertIdent } from './db/schema';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  /** CA certificate of the database server (Supabase); enables verified TLS. */
  databaseCaPem: string | undefined;
  dbSchema: string;
  dbPoolMax: number;
  supabaseUrl: string;
  supabasePublishableKey: string;
  publicOrigin: string;
  shortOrigin: string;
  sharingSecret: string;
  storage:
    | { kind: 'local'; root: string; contentOrigin: string; contentPort: number }
    | { kind: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  clamd: { host: string; port: number } | undefined;
  /** Transfer and notification emails (Resend). Off until a sending domain is verified. */
  mail: { apiKey: string; from: string } | undefined;
  blockedHosts: string[];
  eventRetentionDays: number;
  jobIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
}

function origin(raw: string, name: string, prod: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} must be an origin`);
  }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (prod ? u.protocol !== 'https:' : !['http:', 'https:'].includes(u.protocol)))
    throw new Error(`${name} must be an origin (HTTPS in production)`);
  return u.origin;
}

function int(env: NodeJS.ProcessEnv, name: string, min: number, max: number, fallback: number) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid ${name}`);
  return n;
}

/**
 * Production fails closed: R2 (not local storage), a strong dedicated secret, HTTPS origins, and ClamAV unless the
 * operator explicitly accepts structural checks only. Secrets are never logged.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env['APP_ENV'] ?? env['NODE_ENV'] ?? 'development') as AppConfig['env'];
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('invalid APP_ENV');
  const prod = mode === 'production';
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const databaseUrl = need('DATABASE_URL');
  const dbSchema = assertIdent(env['DB_SCHEMA'] ?? 'rokela');
  const supabaseUrl = prod ? origin(need('SUPABASE_URL'), 'SUPABASE_URL', true) : (env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321');
  const supabasePublishableKey = prod ? need('SUPABASE_PUBLISHABLE_KEY') : (env['SUPABASE_PUBLISHABLE_KEY'] ?? 'dev-publishable-key');
  const publicOrigin = origin(env['PUBLIC_ORIGIN'] ?? (prod ? need('PUBLIC_ORIGIN') : 'http://127.0.0.1:3000'), 'PUBLIC_ORIGIN', prod);
  const shortOrigin = env['SHORT_ORIGIN'] ? origin(env['SHORT_ORIGIN'], 'SHORT_ORIGIN', prod) : publicOrigin;
  const sharingSecret = env['SHARING_SECRET'] ?? (prod ? '' : `dev-only-sharing-secret-${'x'.repeat(32)}`);
  if (sharingSecret.length < 32) throw new Error('SHARING_SECRET must be set (>= 32 chars)');

  const kind = env['STORAGE'] ?? (prod ? 'r2' : 'local');
  let storage: AppConfig['storage'];
  if (kind === 'local') {
    if (prod) throw new Error('production requires STORAGE=r2 (private object storage)');
    const contentPort = int(env, 'CONTENT_PORT', 0, 65535, 3001);
    const contentOrigin = origin(env['CONTENT_ORIGIN'] ?? `http://127.0.0.1:${contentPort}`, 'CONTENT_ORIGIN', false);
    if (contentOrigin === publicOrigin) throw new Error('the content origin must differ from the app origin');
    storage = { kind, root: env['LOCAL_STORAGE_DIR'] ?? join(tmpdir(), 'rokela-pdf-dev'), contentOrigin, contentPort };
  } else if (kind === 'r2') {
    const endpoint = origin(need('R2_ENDPOINT'), 'R2_ENDPOINT', prod);
    if (endpoint === publicOrigin) throw new Error('object storage must be a separate origin from the app');
    const bucket = need('R2_BUCKET');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('invalid R2_BUCKET');
    storage = {
      kind: 's3',
      endpoint,
      region: env['R2_REGION'] ?? 'auto',
      bucket,
      accessKeyId: need('R2_ACCESS_KEY_ID'),
      secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    };
  } else throw new Error('STORAGE must be local or r2');

  let clamd: AppConfig['clamd'];
  if (env['CLAMD_HOST']) clamd = { host: env['CLAMD_HOST'], port: int(env, 'CLAMD_PORT', 1, 65535, 3310) };
  else if (prod && env['MALWARE_SCAN_DISABLED'] !== 'true')
    throw new Error('CLAMD_HOST is required in production (or set MALWARE_SCAN_DISABLED=true to accept structural checks only)');

  // Both or neither: a half-configured mailer would fail only when the first email is due.
  let mail: AppConfig['mail'];
  if (env['RESEND_API_KEY'] || env['MAIL_FROM']) {
    const from = need('MAIL_FROM');
    if (!/^[^<>\r\n]{0,80}<[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}>$|^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(from))
      throw new Error('MAIL_FROM must be an address, e.g. "Rokela PDF Pro <transfers@example.com>"');
    mail = { apiKey: need('RESEND_API_KEY'), from };
  }

  const blockedHosts = (env['BLOCKED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => validateHostname(h));

  return {
    env: mode,
    databaseUrl,
    databaseCaPem: env['DATABASE_CA_PEM'] || undefined,
    dbSchema,
    dbPoolMax: int(env, 'DB_POOL_MAX', 1, 100, 10),
    supabaseUrl,
    supabasePublishableKey,
    publicOrigin,
    shortOrigin,
    sharingSecret,
    storage,
    clamd,
    mail,
    blockedHosts,
    eventRetentionDays: int(env, 'EVENT_RETENTION_DAYS', 1, 3650, 180),
    jobIntervalSeconds: int(env, 'JOB_INTERVAL_SECONDS', 1, 3600, 5),
    maintenanceIntervalSeconds: int(env, 'MAINTENANCE_INTERVAL_SECONDS', 5, 86400, 60),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 1, 1_000_000, 60),
    trustProxy: env['TRUST_PROXY'] === '1',
  };
}
