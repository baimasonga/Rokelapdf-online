// Deployment tooling (schema-owner connection). Run with `npm run <script>`; see docs/deploy.md.
//
//   migrate                                    apply db/migrations to DB_SCHEMA (default rokela)
//   grants   [--role <app_role>]               least-privilege grants for the web app's role (default: APP_DB_ROLE)
//   operator --email <e> --reason <r>          promote a user (who has signed in once) to operator
//   plan     --org <id> --plan <name> --entitlements '<json>' --by <operator email> --reason <r>
//
// Connection: DATABASE_MIGRATE_URL (preferred) or DATABASE_URL; DATABASE_CA_PEM enables verified TLS.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { applyGrants, applyMigrations, assertIdent, MIGRATIONS_DIR } from '../src/lib/server/db/schema';
import { bootstrapOperator, setPlan } from '../src/lib/server/admin';
import { connectionConfig } from '../src/lib/server/db/connect';

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
  },
  strict: true,
});

function need(name: keyof typeof values): string {
  const v = values[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function main() {
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
      default:
        throw new Error('usage: admin.ts migrate | grants | operator | plan (see header)');
    }
  } finally {
    await client.end();
  }
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
