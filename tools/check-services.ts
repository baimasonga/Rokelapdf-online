// Run inside the main app's Railway container: npm run check:services.
// Uses its existing variables. Never prints credentials, URLs, response bodies or document contents.
import pg from 'pg';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/lib/server/config';
import { connectionConfig } from '../src/lib/server/db/connect';
import { ClamdScanner } from '../src/lib/server/storage/clamd';
import { SigV4 } from '../src/lib/server/storage/s3';
import { HttpConverter } from '../src/lib/server/convert';

async function main() {
  const { values } = parseArgs({ options: { only: { type: 'string' } } });
  const components = ['database', 'auth', 'storage', 'clamav', 'converter'];
  if (values.only && !components.includes(values.only)) throw new Error('--only must be database, auth, storage, clamav or converter');
  const c = loadConfig();
  let failed = false;
  async function check(component: string, name: string, run: () => Promise<void>) {
    if (values.only && values.only !== component) return;
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (e) {
      failed = true;
      // Only print fixed messages generated below, or an error class/code. Remote errors can contain secrets.
      const err = e as Error & { code?: string; cause?: { code?: string } };
      console.error(`FAIL ${name}: ${err.name} ${err.code ?? err.cause?.code ?? ''}`);
    }
  }
  async function request(url: string, init: RequestInit = {}) {
    return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  }
  const statusError = (status: number) => Object.assign(new Error(), { code: `HTTP_${status}` });

  await check('database', 'database connection and application schema', async () => {
    const client = new pg.Client({ ...connectionConfig(c.databaseUrl, c.databaseCaPem), connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
    try {
      await client.connect();
      await client.query(`SELECT 1 FROM "${c.dbSchema}".share_accounts LIMIT 0`);
    } finally {
      await client.end();
    }
  });
  await check('auth', 'Supabase Auth and publishable key', async () => {
    const res = await request(`${c.supabaseUrl}/auth/v1/settings`, { headers: { apikey: c.supabasePublishableKey } });
    if (!res.ok) throw statusError(res.status);
    const body = await res.json();
    if (!body || typeof body.external !== 'object') throw Object.assign(new Error(), { code: 'WRONG_AUTH_SERVICE' });
  });
  if (c.storage.kind === 's3') {
    const storage = c.storage;
    await check('storage', 'private object storage credentials and bucket', async () => {
      const signer = new SigV4(storage);
      const path = `/${encodeURIComponent(storage.bucket)}`;
      const headers = signer.authorize('HEAD', path, {}, Buffer.alloc(0), new Date());
      const res = await request(`${storage.endpoint}${path}`, { method: 'HEAD', headers });
      if (!res.ok) throw statusError(res.status);
    });
  } else console.log('SKIP object storage: local development storage configured');

  if (c.clamd) {
    const clamd = c.clamd;
    await check('clamav', 'ClamAV connection and actual INSTREAM scan', async () => {
      const bytes = Buffer.from('%PDF-1.7\n% Rokela service diagnostic\n%%EOF\n');
      const verdict = await new ClamdScanner({ ...clamd, timeoutMs: 15_000 }).scan({
        ext: 'pdf',
        open: async () =>
          (async function* () {
            yield bytes;
          })(),
      });
      if (verdict.verdict !== 'clean') throw Object.assign(new Error(), { code: 'SCAN_NOT_CLEAN' });
    });
  } else console.log('SKIP ClamAV: not configured');

  if (c.converter) {
    const converter = c.converter;
    await check('converter', 'converter service identity and dependencies', async () => {
      const res = await request(`${converter.url}/health`);
      if (!res.ok) throw statusError(res.status);
      const body = await res.json();
      if (body.service !== 'rokela-converter') throw Object.assign(new Error(), { code: 'WRONG_OR_OLD_CONVERTER_SERVICE' });
    });
    await check('converter', 'converter token and real LibreOffice conversion', async () => {
      // Harmless synthetic document; it is never stored by the app or counted against a user's quota.
      const rtf = new TextEncoder().encode('{\\rtf1\\ansi Rokela service diagnostic.}');
      await new HttpConverter({ ...converter, timeoutMs: 180_000 }).convert('pdf', 'rtf', rtf);
    });
  } else console.log('SKIP converter: not configured');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e: Error) => {
  console.error(`FAIL configuration: ${e.message}`); // loadConfig's fixed messages never include values.
  process.exitCode = 1;
});
