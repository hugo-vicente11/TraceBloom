/**
 * ClickHouse + Postgres access for the demo lifecycle: bulk inserts of the
 * generated corpus, counting, and the service-scoped deletes `reset` uses.
 * Demo data is namespaced by service_name (DEMO_SERVICE / SANDBOX_SERVICE), so
 * deletion can never touch telemetry from anything else.
 */

import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { type Database, evalRegressions, evalState } from '@tracebloom/db';
import { inArray } from 'drizzle-orm';
import { DEMO_SERVICE, SANDBOX_SERVICE } from './corpus.js';
import type { DemoConfig } from './env.js';

export const DEMO_SERVICES = [DEMO_SERVICE, SANDBOX_SERVICE];

export function createDemoClickHouse(config: DemoConfig): ClickHouseClient {
  return createClient({
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
  });
}

export async function insertRows(
  ch: ClickHouseClient,
  table: string,
  rows: object[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await ch.insert({
    table,
    values: rows,
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
}

export async function countDemoSpans(ch: ClickHouseClient, service: string): Promise<number> {
  const rs = await ch.query({
    query: 'SELECT count() AS c FROM tracebloom.spans WHERE service_name = {service:String}',
    query_params: { service },
    format: 'JSONEachRow',
  });
  return Number((await rs.json<{ c: string }>())[0]?.c ?? 0);
}

/** Delete every demo/sandbox row from ClickHouse (spans, events, results). */
export async function deleteDemoTelemetry(ch: ClickHouseClient): Promise<void> {
  // span_events carries no service column; resolve the trace ids first.
  const rs = await ch.query({
    query:
      'SELECT DISTINCT trace_id FROM tracebloom.spans WHERE service_name IN {services:Array(String)}',
    query_params: { services: DEMO_SERVICES },
    format: 'JSONEachRow',
  });
  const traceIds = (await rs.json<{ trace_id: string }>()).map((r) => r.trace_id);

  if (traceIds.length > 0) {
    await ch.command({
      query: 'DELETE FROM tracebloom.span_events WHERE trace_id IN {ids:Array(String)}',
      query_params: { ids: traceIds },
    });
  }
  await ch.command({
    query: 'DELETE FROM tracebloom.eval_results WHERE service_name IN {services:Array(String)}',
    query_params: { services: DEMO_SERVICES },
  });
  await ch.command({
    query: 'DELETE FROM tracebloom.spans WHERE service_name IN {services:Array(String)}',
    query_params: { services: DEMO_SERVICES },
  });
}

/**
 * Clear the runner's per-eval cursors and previously detected regressions for
 * the demo evals, so detection re-fires cleanly against a fresh corpus.
 */
export async function clearEvalRunnerState(db: Database, evalIds: string[]): Promise<void> {
  if (evalIds.length === 0) {
    return;
  }
  await db.delete(evalState).where(inArray(evalState.evalId, evalIds));
  await db.delete(evalRegressions).where(inArray(evalRegressions.evalId, evalIds));
}
