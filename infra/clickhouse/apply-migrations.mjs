/**
 * Apply ClickHouse migrations over HTTP: the containerized twin of
 * migrate.sh for images that ship node but no curl (the worker image runs
 * this as part of the one-shot `migrate` service). Same contract: every
 * migration file is a single idempotent statement, applied in name order.
 *
 * Env: CLICKHOUSE_URL (default http://localhost:8123), CLICKHOUSE_USER
 * (default `default`), CLICKHOUSE_PASSWORD (default empty).
 */

import { readdir, readFile } from 'node:fs/promises';

const url = (process.env.CLICKHOUSE_URL ?? 'http://localhost:8123').replace(/\/+$/, '');
const user = process.env.CLICKHOUSE_USER ?? 'default';
const password = process.env.CLICKHOUSE_PASSWORD ?? '';

const dir = new URL('./migrations/', import.meta.url);
const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

/** POST one statement, retrying connection-level failures (ClickHouse restarts
 * once during first-boot initialization, briefly refusing connections). */
async function apply(sql) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(`${url}/?default_format=JSONEachRow`, {
        method: 'POST',
        body: sql,
        headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password },
      });
    } catch (error) {
      if (attempt >= 30) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

console.log(`Applying ${files.length} ClickHouse migrations -> ${url}`);
for (const name of files) {
  const sql = await readFile(new URL(name, dir), 'utf8');
  const response = await apply(sql);
  if (!response.ok) {
    console.error(`migration failed: ${name}: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  console.log(`  -> ${name}`);
}
console.log('ClickHouse migrations applied.');
