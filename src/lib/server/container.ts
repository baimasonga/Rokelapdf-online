import { WarriorMonitor } from './warrior';
import 'server-only';
import { resolveTxt } from 'node:dns/promises';
import pg from 'pg';
import { loadConfig, type AppConfig } from './config';
import { DomainError, systemClock, type Clock } from './kernel';
import { SupabaseTokenVerifier, type TokenVerifier } from './auth';
import { WorkspaceService } from './workspaces';
import { RateLimiter } from './rate-limit';
import type { PgPool } from './db/pg';
import { PgSharingStore } from './db/pg-sharing-store';
import { assertIdent } from './db/schema';
import { connectionConfig } from './db/connect';
import { LocalObjectStore } from './storage/local';
import { S3ObjectStore } from './storage/s3';
import { ClamdScanner } from './storage/clamd';
import { CloudflareMailer, ResendMailer, type Mailer } from './mail';
import { ConversionService, HttpConverter, type ConversionLimits, type Converter } from './convert';
import { BasicContentScanner, ChainedScanner, DEFAULT_SHARING_CONFIG, SharingKeys, SharingService, type FileScanner, type ObjectStore } from './sharing';

export interface Container {
  config: AppConfig;
  clock: Clock;
  pool: PgPool;
  verifier: TokenVerifier;
  workspaces: WorkspaceService;
  sharing: SharingService;
  rateLimiter: RateLimiter;
  conversions: ConversionService;
  warrior: WarriorMonitor | undefined;
  localStore: LocalObjectStore | undefined;
  close(): Promise<void>;
}

export interface Overrides {
  pool?: PgPool;
  clock?: Clock;
  verifier?: TokenVerifier;
  objects?: ObjectStore;
  scanner?: FileScanner;
  resolveTxt?: (name: string) => Promise<string[][]>;
  sharing?: Partial<typeof DEFAULT_SHARING_CONFIG>;
  mailer?: Mailer;
  converter?: Converter;
  conversionLimits?: Partial<ConversionLimits>;
}

function poolFor(c: AppConfig): pg.Pool {
  const schema = assertIdent(c.dbSchema);
  // The search path is a connection startup parameter, so it is in place before the first query. `npm run db:grants`
  // also makes it the app role's default, which covers poolers that do not forward startup parameters.
  const settings: pg.PoolConfig = { ...connectionConfig(c.databaseUrl, c.databaseCaPem), max: c.dbPoolMax, options: `-c search_path=${schema}` };
  const pool = new pg.Pool(settings);
  return pool;
}

/** Composition root. Everything environment-specific is chosen here. */
export function createContainer(config: AppConfig = loadConfig(), o: Overrides = {}): Container {
  const clock = o.clock ?? systemClock;
  const ownPool = o.pool ? undefined : poolFor(config);
  const pool: PgPool = o.pool ?? ownPool!;
  const verifier = o.verifier ?? new SupabaseTokenVerifier({ supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey });
  const workspaces = new WorkspaceService(pool, clock, config.trialMode);
  let localStore: LocalObjectStore | undefined;
  let objects = o.objects;
  if (!objects) {
    if (config.storage.kind === 'local') {
      localStore = new LocalObjectStore({
        root: config.storage.root,
        signingSecret: config.sharingSecret,
        contentOrigin: config.storage.contentOrigin,
        minPartBytes: 1,
      });
      objects = localStore;
    } else objects = new S3ObjectStore(config.storage, { now: () => clock.now() });
  }
  const mailer =
    o.mailer ?? (config.mail ? (config.mail.provider === 'cloudflare' ? new CloudflareMailer(config.mail) : new ResendMailer(config.mail)) : undefined);
  const monitorPool =
    config.warrior && !o.pool
      ? new pg.Pool({
          ...connectionConfig(config.databaseUrl, config.databaseCaPem),
          max: 2,
          connectionTimeoutMillis: 1000,
          query_timeout: 1000,
          statement_timeout: 1000,
          lock_timeout: 250,
          options: `-c search_path=${assertIdent(config.dbSchema)}`,
        })
      : undefined;
  const warrior = config.warrior ? new WarriorMonitor(monitorPool ?? pool, clock, config.warrior) : undefined;
  const basic = new BasicContentScanner();
  const actualScanner = o.scanner ?? (config.clamd ? new ChainedScanner([basic, new ClamdScanner(config.clamd)]) : basic);
  const scanner: FileScanner =
    warrior && config.warrior
      ? {
          name: actualScanner.name,
          async scan(input) {
            try {
              const result = await actualScanner.scan(input);
              await warrior.capture(config.warrior!.scannerComponentId, { type: 'component.heartbeat', attributes: { status: 'healthy' } });
              if (result.verdict === 'rejected' && result.reason?.startsWith('malware:'))
                await warrior.capture(config.warrior!.scannerComponentId, { type: 'malware.detected', attributes: { verdict: 'malicious' } });
              return result;
            } catch (error) {
              await warrior.capture(config.warrior!.scannerComponentId, { type: 'component.heartbeat', attributes: { status: 'unavailable' } });
              await warrior.scannerUnavailable(config.warrior!.scannerComponentId);
              throw error;
            }
          },
        }
      : actualScanner;
  const sharing = new SharingService({
    store: new PgSharingStore(pool, clock),
    objects,
    scanner,
    keys: new SharingKeys(config.sharingSecret),
    clock,
    config: {
      ...DEFAULT_SHARING_CONFIG,
      trialMode: config.trialMode,
      eventRetentionDays: config.eventRetentionDays,
      ...(config.env === 'production' ? {} : { partBytes: 5 * 1024 * 1024 }),
      ...o.sharing,
      publicOrigin: config.publicOrigin,
      shortOrigin: config.shortOrigin,
    },
    destinations: {
      reservedHosts: [new URL(config.publicOrigin).hostname, new URL(config.shortOrigin).hostname],
      blockedHosts: config.blockedHosts,
    },
    authorize: async (p, orgId, perm) => void (await workspaces.require(p, orgId, perm)),
    identity: (userId) => workspaces.contact(userId),
    isMember: (orgId, userId) => workspaces.isMember(orgId, userId),
    entitlements: (orgId) => workspaces.entitlements(orgId),
    passwords: { hash: hashPassword, verify: verifyPassword },
    resolveTxt: o.resolveTxt ?? ((n) => resolveTxt(n)),
    ...(mailer ? { mailer } : {}),
  });
  const rateLimiter = new RateLimiter(pool, clock);
  const actualConverter = o.converter ?? (config.converter ? new HttpConverter(config.converter) : undefined);
  const converter: Converter | undefined =
    actualConverter && warrior && config.warrior
      ? {
          async convert(target, from, bytes) {
            const started = +clock.now();
            try {
              const out = await actualConverter.convert(target, from, bytes);
              await warrior.capture(config.warrior!.converterComponentId, { type: 'component.heartbeat', attributes: { status: 'healthy' } });
              return out;
            } catch (error) {
              const inputRefusal = error instanceof DomainError && ['unprocessable', 'invalid_request', 'too_large'].includes(error.code);
              await warrior.capture(config.warrior!.converterComponentId, {
                type: 'component.heartbeat',
                attributes: { status: inputRefusal ? 'healthy' : 'unavailable' },
              });
              await warrior.capture(config.warrior!.converterComponentId, {
                type: 'conversion.failed',
                attributes: {
                  source_type: from === 'pdf' ? 'pdf' : 'office',
                  target_type: target === 'pdf' ? 'pdf' : 'office',
                  reason: inputRefusal ? 'unsupported' : 'worker_unavailable',
                  duration_ms: Math.max(0, Math.min(86400000, +clock.now() - started)),
                },
              });
              throw error;
            }
          },
        }
      : actualConverter;
  const conversions = new ConversionService({
    converter,
    hit: (key, limit, windowSeconds) => rateLimiter.hit(key, limit, windowSeconds),
    ...(o.conversionLimits ? { limits: o.conversionLimits } : {}),
  });
  return {
    config,
    clock,
    pool,
    verifier,
    workspaces,
    sharing,
    rateLimiter,
    conversions,
    warrior,
    localStore,
    close: async () => {
      await monitorPool?.end();
      await ownPool?.end();
    },
  };
}

// ---- passwords for link protection (scrypt, self-describing format) ----------------------------------------
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const SCRYPT = { N: 16384, r: 8, p: 1 };
function derive(pw: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(pw.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e ? rej(e) : res(k))));
}
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const k = await derive(pw, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${k.toString('base64url')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 2 ** 20) return false;
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await derive(pw, Buffer.from(parts[4]!, 'base64url'), N, r, p);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---- process-wide singleton (Next.js may load route modules several times) --------------------------------
const g = globalThis as unknown as { __rokela?: Container };
export function container(): Container {
  return (g.__rokela ??= createContainer());
}
