/**
 * Post-seed verification, used by the CI smoke test and after a manual seed:
 * asserts the corpus is present and correctly shaped, and polls until the
 * (watch-mode) eval runner has flagged the seeded v2 regression. Exits
 * non-zero with a specific message on the first failed check.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, evalDefinitions, evalRegressions } from '@tracebloom/db';
import { inArray } from 'drizzle-orm';
import { DEMO_SERVICE, DEMO_VARIANTS } from './corpus.js';
import { loadDemoConfig } from './env.js';
import { EVAL_NAMES } from './evals.js';
import { createDemoClickHouse } from './store.js';

const log = (message: string): void => {
  console.log(`[demo:verify] ${message}`);
};

function fail(message: string): never {
  console.error(`[demo:verify] ❌ ${message}`);
  process.exit(1);
}

export interface VerifyOptions {
  /** How long to keep polling for the runner-detected regression. */
  regressionTimeoutMs?: number;
}

export async function verifyDemo(options: VerifyOptions = {}): Promise<void> {
  const config = loadDemoConfig();
  const ch = createDemoClickHouse(config);
  const { db, pool } = createDb();
  const regressionTimeoutMs = options.regressionTimeoutMs ?? 90_000;

  try {
    const one = async <T>(query: string): Promise<T | undefined> => {
      const rs = await ch.query({
        query,
        query_params: { service: DEMO_SERVICE },
        format: 'JSONEachRow',
      });
      return (await rs.json<T>())[0];
    };

    const spanStats = await one<{ spans: string; traces: string; errors: string }>(`
      SELECT toString(count()) AS spans,
             toString(uniqExact(trace_id)) AS traces,
             toString(countIf(status_code = 'ERROR' AND parent_span_id = '')) AS errors
      FROM tracebloom.spans WHERE service_name = {service:String}
    `);
    const spans = Number(spanStats?.spans ?? 0);
    const traces = Number(spanStats?.traces ?? 0);
    const errorRoots = Number(spanStats?.errors ?? 0);
    if (traces < 50) {
      fail(`expected >= 50 demo traces, found ${traces}`);
    }
    if (spans < 400) {
      fail(`expected >= 400 demo spans, found ${spans}`);
    }
    if (errorRoots < 2) {
      fail(`expected >= 2 failed demo runs (ERROR roots), found ${errorRoots}`);
    }
    log(`corpus present: ${traces} traces / ${spans} spans / ${errorRoots} failed runs`);

    const retries = await one<{ c: string }>(`
      SELECT toString(countIf(JSONExtractInt(attributes_json, 'tracebloom.retry.attempt') >= 2)) AS c
      FROM tracebloom.spans WHERE service_name = {service:String}
    `);
    if (Number(retries?.c ?? 0) < 5) {
      fail(`expected >= 5 retry spans, found ${Number(retries?.c ?? 0)}`);
    }
    log(`retries visible: ${Number(retries?.c)} retry spans`);

    const events = await one<{ c: string }>(`
      SELECT toString(count()) AS c
      FROM tracebloom.span_events
      WHERE name IN ('gen_ai.user.message', 'gen_ai.choice')
        AND trace_id IN (
          SELECT DISTINCT trace_id FROM tracebloom.spans WHERE service_name = {service:String}
        )
    `);
    if (Number(events?.c ?? 0) < 200) {
      fail(`expected >= 200 content events, found ${Number(events?.c ?? 0)}`);
    }

    const defs = await db
      .select()
      .from(evalDefinitions)
      .where(inArray(evalDefinitions.name, [...EVAL_NAMES]));
    if (defs.length !== EVAL_NAMES.length) {
      fail(`expected ${EVAL_NAMES.length} eval definitions, found ${defs.length}`);
    }

    const variantStats = await ch.query({
      query: `
        SELECT variant, toString(count()) AS c
        FROM tracebloom.eval_results FINAL
        WHERE service_name = {service:String}
          AND span_start_time >= now() - INTERVAL 24 HOUR
        GROUP BY variant
      `,
      query_params: { service: DEMO_SERVICE },
      format: 'JSONEachRow',
    });
    const byVariant = new Map(
      (await variantStats.json<{ variant: string; c: string }>()).map((r) => [
        r.variant,
        Number(r.c),
      ]),
    );
    for (const variant of [DEMO_VARIANTS.baseline, DEMO_VARIANTS.regressed]) {
      const count = byVariant.get(variant) ?? 0;
      if (count < 20) {
        fail(`variant ${variant}: expected >= 20 eval results in the last 24h, found ${count}`);
      }
    }
    log(
      `eval results per variant (24h): ${[...byVariant.entries()].map(([v, c]) => `${v}=${c}`).join(' ')}`,
    );

    // The regression signal is produced by the REAL runner. Poll for it.
    const defIds = defs.map((d) => d.id);
    const deadline = Date.now() + regressionTimeoutMs;
    log('waiting for the eval runner to flag the v2 regression…');
    for (;;) {
      const rows = await db
        .select()
        .from(evalRegressions)
        .where(inArray(evalRegressions.evalId, defIds));
      const hit = rows.find((r) => r.variant === DEMO_VARIANTS.regressed);
      if (hit) {
        log(
          `✅ regression flagged: ${hit.metric} of ${hit.variant} vs ${hit.baselineVariant} ` +
            `(${hit.baselineValue.toFixed(3)} -> ${hit.currentValue.toFixed(3)})`,
        );
        break;
      }
      if (Date.now() > deadline) {
        fail(
          'no regression detected in time. Is the eval runner running? ' +
            '(watch mode in the prod stack, or run `pnpm eval:run` once locally)',
        );
      }
      await sleep(3000);
    }

    log('✅ demo verified.');
  } finally {
    await ch.close();
    await pool.end();
  }
}
