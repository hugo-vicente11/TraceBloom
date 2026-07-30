/**
 * Eval-runner CLI.
 *
 *   tracebloom-eval run           # score once against landed spans, then exit
 *   tracebloom-eval run --watch   # run continuously on an interval
 *   tracebloom-eval seed          # insert the sample eval definitions
 *
 * The SDK is initialized so the judge's own model calls are traced to the
 * collector (dogfooding); the judge client is only built when an API key is set.
 */

import { createDb } from '@tracebloom/db';
import { init, shutdown } from '@tracebloom/sdk';
import { createEvalClickHouse } from './clickhouse.js';
import { loadRunnerConfig } from './env.js';
import { createJudgeClient, JUDGE_SERVICE_NAME } from './judge-client.js';
import { type EvalRunSummary, type Logger, runOnce } from './runner.js';
import { seedSampleEvals } from './seed.js';

const log: Logger = (message, meta) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...meta }));
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printSummaries(summaries: EvalRunSummary[]): void {
  for (const s of summaries) {
    if (s.skipped) {
      console.log(`  · ${s.evalName}: skipped (${s.skipped})`);
      continue;
    }
    console.log(
      `  · ${s.evalName}: scanned=${s.scanned} scored=${s.scored} cached=${s.cached} ` +
        `skippedExisting=${s.skippedExisting} errors=${s.errors} regressions=${s.regressions}`,
    );
  }
}

async function runCommand(watch: boolean): Promise<void> {
  const config = loadRunnerConfig();
  init({ endpoint: config.collectorEndpoint, serviceName: JUDGE_SERVICE_NAME });
  const ch = createEvalClickHouse();
  const { db, pool } = createDb();
  const judgeClient = createJudgeClient(config);
  if (!judgeClient) {
    log('no judge API key set — llm_judge evals will be skipped');
  }
  const deps = { ch, db, config, judgeClient, logger: log };

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    do {
      const started = Date.now();
      const summaries = await runOnce(deps);
      console.log(`[eval-runner] run complete in ${Date.now() - started}ms`);
      printSummaries(summaries);
      if (watch && !stopping) {
        await sleep(config.intervalMs);
      }
    } while (watch && !stopping);
  } finally {
    await shutdown();
    await ch.close();
    await pool.end();
  }
}

async function seedCommand(): Promise<void> {
  const { db, pool } = createDb();
  try {
    const inserted = await seedSampleEvals(db);
    if (inserted.length === 0) {
      console.log('[eval-runner] sample evals already present — nothing to seed');
    } else {
      console.log(
        `[eval-runner] seeded ${inserted.length} eval(s): ${inserted.map((e) => e.name).join(', ')}`,
      );
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'run';
  switch (command) {
    case 'run':
      await runCommand(args.includes('--watch'));
      break;
    case 'seed':
      await seedCommand();
      break;
    default:
      console.error(`unknown command "${command}". Usage: tracebloom-eval <run [--watch] | seed>`);
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error('[eval-runner] fatal:', error);
  process.exit(1);
});
