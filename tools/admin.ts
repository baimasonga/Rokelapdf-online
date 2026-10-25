// Deployment tooling (schema-owner connection). Run with `npm run <script>`; see docs/deploy.md.
//
//   config                                     validate the app's settings as the server will read them (no database)
//   migrate                                    apply db/migrations to DB_SCHEMA (default rokela)
//   grants   [--role <app_role>]               least-privilege grants for the web app's role (default: APP_DB_ROLE)
//   operator --email <e> --reason <r>          promote a user (who has signed in once) to operator
//   plan     --org <id> --plan <name> --entitlements '<json>' --by <operator email> --reason <r>
//   license         --email <e> [--years 1] --by <operator email> --reason <r>   grant or renew a licence (docs/licensing.md)
//   license-revoke  --email <e> --by <operator email> --reason <r>              end a licence now
//   license-show    --email <e>                                                 show the licence for an email
//
// Connection: DATABASE_MIGRATE_URL (preferred) or DATABASE_URL; DATABASE_CA_PEM enables verified TLS.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { applyGrants, applyMigrations, assertIdent, MIGRATIONS_DIR } from '../src/lib/server/db/schema';
import { bootstrapOperator, grantLicense, revokeLicense, setPlan, showLicense } from '../src/lib/server/admin';
import { connectionConfig } from '../src/lib/server/db/connect';
import { loadConfig } from '../src/lib/server/config';
import { authEmailOptions } from '../src/lib/server/auth-email';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    role: { type: 'string' },
    email: { type: 'string' },
    reason: { type: 'string' },
    org: { type: 'string' },
    plan: { type: 'string' },
    entitlements: { type: 'string' },
    by: { type: 'string' },
    years: { type: 'string' },
  },
  strict: true,
});

function need(name: keyof typeof values): string {
  const v = values[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

/**
 * Reads the settings exactly as the server does at startup. Runs first in the pre-deploy step, so a bad setting fails
 * the deploy and the running version stays live, instead of the new one refusing every request.
 */
function checkConfig() {
  const config = loadConfig(process.env);
  authEmailOptions(process.env);
  console.log(`settings valid for ${config.env} at ${config.publicOrigin}${config.warrior ? ' (monitoring on)' : ''}`);
}

async function main() {
  if (command === 'config') return checkConfig();
  const url = process.env['DATABASE_MIGRATE_URL'] || process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_MIGRATE_URL or DATABASE_URL is required');
  const schema = assertIdent(process.env['DB_SCHEMA'] ?? 'rokela');
  const ca = process.env['DATABASE_CA_PEM'];
  const client = new pg.Client(connectionConfig(url, ca));
  await client.connect();
  try {
    await client.query(`SET search_path = "${schema}"`);
    switch (command) {
      case 'migrate':
        await applyMigrations(client, MIGRATIONS_DIR, schema);
        console.log(`migrations applied to schema ${schema}`);
        break;
      case 'grants': {
        const role = values.role ?? process.env['APP_DB_ROLE'];
        if (!role) throw new Error('--role or APP_DB_ROLE is required');
        const stmts = await applyGrants(client, schema, assertIdent(role));
        console.log(`applied ${stmts.length} grant statements`);
        break;
      }
      case 'operator': {
        const r = await bootstrapOperator(client, { email: need('email'), reason: values.reason });
        console.log(r.changed ? `user ${r.userId} is now an operator` : `user ${r.userId} was already an operator`);
        break;
      }
      case 'plan': {
        let ents: unknown;
        try {
          ents = JSON.parse(need('entitlements'));
        } catch {
          throw new Error('--entitlements must be JSON');
        }
        const r = await setPlan(client, { orgId: need('org'), plan: need('plan'), entitlements: ents, byEmail: need('by'), reason: values.reason });
        console.log(`workspace ${r.orgId} is on plan ${r.plan}`);
        break;
      }
      case 'license': {
        const years = values.years === undefined ? 1 : Number(values.years);
        const r = await grantLicense(client, { email: need('email'), years, byEmail: need('by'), reason: values.reason });
        console.log(`${r.email} is licensed until ${r.validUntil.toISOString().slice(0, 10)}`);
        break;
      }
      case 'license-revoke': {
        const r = await revokeLicense(client, { email: need('email'), byEmail: need('by'), reason: values.reason });
        console.log(r.changed ? `licence for ${r.email} ended now` : `licence for ${r.email} had already ended`);
        break;
      }
      case 'license-show': {
        const l = await showLicense(client, need('email'));
        console.log(
          l
            ? `${l.email}: ${l.valid_from.toISOString().slice(0, 10)} to ${l.valid_until.toISOString().slice(0, 10)} (${l.reason})`
            : 'no licence for that email',
        );
        break;
      }
      default:
        throw new Error('usage: admin.ts migrate | grants | operator | plan | license | license-revoke | license-show (see header)');
    }
  } finally {
    await client.end();
  }
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
