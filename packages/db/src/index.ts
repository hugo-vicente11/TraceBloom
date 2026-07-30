/**
 * Type-safe Postgres access for TraceBloom config. Exposes the schema and a
 * `createDb` factory returning a Drizzle client bound to the connection pool.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export * from './schema.js';

const DEFAULT_URL = 'postgres://tracebloom:tracebloom@localhost:5432/tracebloom';

/** Resolve the Postgres connection string from `DATABASE_URL` (dev default otherwise). */
export function connectionString(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

/** Create a Drizzle database client. Caller owns the lifecycle via the returned pool. */
export function createDb(url: string = connectionString()): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: Pool;
} {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDb>['db'];
