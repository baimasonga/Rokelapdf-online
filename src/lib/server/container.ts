import 'server-only';
import { resolveTxt } from 'node:dns/promises';
import pg from 'pg';
import { loadConfig, type AppConfig } from './config';
import { systemClock, type Clock } from './kernel';
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
import { BasicContentScanner, ChainedScanner, DEFAULT_SHARING_CONFIG, SharingKeys, SharingService, type FileScanner, type ObjectStore } from './sharing';

export interface Container {
  config: AppConfig;
  clock: Clock;
  pool: PgPool;
  verifier: TokenVerifier;
  workspaces: WorkspaceService;
  sharing: SharingService;
  rateLimiter: RateLimiter;
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
  const workspaces = new WorkspaceService(pool, clock);
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
  const basic = new BasicContentScanner();
  const scanner = o.scanner ?? (config.clamd ? new ChainedScanner([basic, new ClamdScanner(config.clamd)]) : basic);
  const sharing = new SharingService({
    store: new PgSharingStore(pool, clock),
    objects,
    scanner,
    keys: new SharingKeys(config.sharingSecret),
    clock,
    config: {
      ...DEFAULT_SHARING_CONFIG,
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
  });
  return {
    config,
    clock,
    pool,
    verifier,
    workspaces,
    sharing,
    rateLimiter: new RateLimiter(pool, clock),
    localStore,
    close: async () => void (await ownPool?.end()),
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
