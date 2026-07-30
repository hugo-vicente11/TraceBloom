/**
 * Apply pending Postgres migrations from `./drizzle`. Run with `pnpm db:migrate`
 * (uses tsx) or `node dist/migrate.js` after a build; resolves the migrations
 * folder relative to this file so both work.
 */

import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { connectionString } from './index.js';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: connectionString() });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') });
    console.log('Postgres migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Postgres migration failed:', error);
  process.exit(1);
});
