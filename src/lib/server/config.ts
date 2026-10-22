import { warriorConfig, type WarriorConfig } from './warrior-config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateHostname } from './sharing';
import { assertIdent } from './db/schema';

export interface AppConfig {
  /** Temporary trial access; quotas and workspace authorization still apply. */
  trialMode: boolean;
  warrior?: WarriorConfig;
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
  /** Transfer and notification emails. Off until a provider and verified sender are configured. */
  mail: { provider: 'resend'; apiKey: string; from: string } | { provider: 'cloudflare'; apiToken: string; accountId: string; from: string } | undefined;
  /** The Office conversion service (a separate private service). Off unless both URL and token are set. */
  converter: { url: string; token: string } | undefined;
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
  const trial = env['TRIAL_MODE'] ?? 'true';
  if (!['true', 'false'].includes(trial)) throw new Error('TRIAL_MODE must be true or false');
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

  // A configured provider must be complete; retain existing Resend installations.
  let mail: AppConfig['mail'];
  const cloudflareMail = !!env['CLOUDFLARE_EMAIL_API_TOKEN'];
  if (!env['MAIL_PROVIDER'] && cloudflareMail && env['RESEND_API_KEY']) throw new Error('MAIL_PROVIDER is required when both email providers are configured');
  const provider = env['MAIL_PROVIDER'] ?? (cloudflareMail ? 'cloudflare' : 'resend');
  if (provider !== 'resend' && provider !== 'cloudflare') throw new Error('MAIL_PROVIDER must be resend or cloudflare');
  if (env['MAIL_PROVIDER'] || env['RESEND_API_KEY'] || env['MAIL_FROM'] || cloudflareMail) {
    const from = need('MAIL_FROM');
    if (!/^[^<>\r\n]{0,80}<[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}>$|^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(from))
      throw new Error('MAIL_FROM must be an address, e.g. "Rokela PDF Pro <transfers@example.com>"');
    if (provider === 'cloudflare') {
      const accountId = need('CLOUDFLARE_ACCOUNT_ID');
      if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID');
      mail = { provider, accountId, apiToken: need('CLOUDFLARE_EMAIL_API_TOKEN'), from };
    } else mail = { provider, apiKey: need('RESEND_API_KEY'), from };
  }

  // HTTP is limited to Railway's private network or the co-located container service.
  let converter: AppConfig['converter'];
  if (env['CONVERTER_URL'] || env['CONVERTER_TOKEN']) {
    const raw = need('CONVERTER_URL').trim();
    // Railway's private-domain reference is a hostname, without a scheme or port.
    // Only that exact host format gets defaults; other URLs must be explicit.
    const privateHost = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.railway\.internal(?::[0-9]+)?$/i.test(raw);
    const address = privateHost ? `http://${raw}${raw.includes(':') ? '' : ':8080'}` : raw;
    const invalidOrigin = () =>
      new Error(
        'CONVERTER_URL must be an origin, e.g. http://converter.railway.internal:8080 or https://convert.example.com (no credentials, path, query or fragment)',
      );
    let u: URL;
    try {
      u = new URL(address);
    } catch {
      throw invalidOrigin();
    }
    const privateNet = u.protocol === 'http:' && u.hostname.endsWith('.railway.internal');
    const loopback = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) throw invalidOrigin();
    if (prod && u.protocol !== 'https:' && !privateNet && !loopback)
      throw new Error('CONVERTER_URL must be HTTPS, loopback or a *.railway.internal address in production');
    const token = need('CONVERTER_TOKEN');
    if (token.length < 32) throw new Error('CONVERTER_TOKEN must be at least 32 characters');
    converter = { url: u.origin, token };
  }

  const blockedHosts = (env['BLOCKED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => validateHostname(h));

  return {
    trialMode: trial === 'true',
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
    converter,
    blockedHosts,
    eventRetentionDays: int(env, 'EVENT_RETENTION_DAYS', 1, 3650, 180),
    jobIntervalSeconds: int(env, 'JOB_INTERVAL_SECONDS', 1, 3600, 5),
    maintenanceIntervalSeconds: int(env, 'MAINTENANCE_INTERVAL_SECONDS', 5, 86400, 60),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 1, 1_000_000, 60),
    warrior: warriorConfig(env),
    trustProxy: env['TRUST_PROXY'] === '1',
  };
}
