/**
 * Create/refresh the read-only Postgres role the public dashboard connects
 * with (DECISIONS.md D25). Idempotent: safe to run on every deploy. Run as the
 * schema-owning admin user (DATABASE_URL); the role password comes from
 * TRACEBLOOM_PG_RO_PASSWORD.
 *
 * The role gets SELECT and nothing else: plus default privileges so tables
 * created by future migrations are readable without re-running this.
 */

import { Client } from 'pg';
import { connectionString } from './index.js';

const ROLE = 'tracebloom_ro';

async function main(): Promise<void> {
  const password = process.env.TRACEBLOOM_PG_RO_PASSWORD;
  if (!password) {
    console.error('TRACEBLOOM_PG_RO_PASSWORD is not set; refusing to create a passwordless role.');
    process.exit(1);
  }

  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const adminUser = (await client.query<{ current_user: string }>('SELECT current_user')).rows[0]
      ?.current_user;
    const database = (await client.query<{ current_database: string }>('SELECT current_database()'))
      .rows[0]?.current_database;
    if (!adminUser || !database) {
      throw new Error('could not resolve current user/database');
    }

    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
           CREATE ROLE ${ROLE} LOGIN;
         END IF;
       END $$`,
    );
    // ALTER ROLE cannot take bind parameters; escape via the driver.
    await client.query(`ALTER ROLE ${ROLE} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${client.escapeIdentifier(adminUser)} IN SCHEMA public
         GRANT SELECT ON TABLES TO ${ROLE}`,
    );
    console.log(`Read-only role ${ROLE} is ready (SELECT-only on ${database}).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('setup-readonly-role failed:', error);
  process.exit(1);
});
