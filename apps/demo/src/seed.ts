/**
 * Demo lifecycle orchestration.
 *
 * seed: load the curated demo project. Idempotent: a second run is a no-op
 *         (pass force to wipe + reload instead).
 * reset: wipe demo/sandbox telemetry and runner state, then seed fresh.
 *
 * The corpus timeline is relative to "now", so a reset also re-anchors the
 * demo to look freshly active.
 */

import { createDb, projects } from '@tracebloom/db';
import { DEMO_SERVICE, generateCorpus } from './corpus.js';
import { loadDemoConfig } from './env.js';
import { buildEvalResults, ensureEvalDefinitions } from './evals.js';
import { runHeroTrace } from './hero.js';
import {
  clearEvalRunnerState,
  countDemoSpans,
  createDemoClickHouse,
  deleteDemoTelemetry,
  insertRows,
} from './store.js';

const log = (message: string): void => {
  console.log(`[demo] ${message}`);
};

export interface SeedOptions {
  /** Wipe existing demo data first instead of skipping. */
  force?: boolean;
  /** Skip the SDK-emitted hero trace (unit/CI contexts without a collector). */
  skipHero?: boolean;
}

export async function seedDemo(options: SeedOptions = {}): Promise<void> {
  const config = loadDemoConfig();
  const ch = createDemoClickHouse(config);
  const { db, pool } = createDb();
  try {
    const existing = await countDemoSpans(ch, DEMO_SERVICE);
    if (existing > 0 && !options.force) {
      log(`already seeded (${existing} demo spans present) — nothing to do.`);
      log('run `reset` to wipe and reseed with a fresh timeline.');
      return;
    }

    // Postgres config first: the demo project row and the two eval defs.
    await db
      .insert(projects)
      .values({
        slug: 'demo',
        name: 'Researcher agent (demo)',
        description:
          'Curated public demo: a multi-step researcher agent traced end-to-end, with evals and an A/B prompt regression.',
        settings: { demo: true },
      })
      .onConflictDoNothing();
    const defs = await ensureEvalDefinitions(db);
    log(`eval definitions ready: ${defs.map((d) => d.name).join(', ')}`);

    if (existing > 0) {
      log(`force: deleting ${existing} existing demo spans (and their events/results)…`);
      await deleteDemoTelemetry(ch);
    }
    // Fresh detection against the fresh corpus.
    await clearEvalRunnerState(
      db,
      defs.map((d) => d.id),
    );

    const corpus = generateCorpus({ nowMs: Date.now() });
    log(
      `inserting corpus: ${corpus.traces.length} traces, ${corpus.spans.length} spans, ` +
        `${corpus.events.length} events…`,
    );
    await insertRows(ch, 'spans', corpus.spans);
    await insertRows(ch, 'span_events', corpus.events);

    const results = await buildEvalResults(corpus.chatSpans, defs);
    log(`inserting ${results.length} eval results (deterministic + judge)…`);
    await insertRows(ch, 'eval_results', results);

    if (!options.skipHero) {
      log('emitting the hero trace through the SDK -> collector…');
      const heroTraceId = await runHeroTrace(config, ch);
      log(`hero trace landed: ${config.dashboardUrl}/traces/${heroTraceId}`);
    }

    log('✅ demo seeded.');
    log(`   open ${config.dashboardUrl}/traces — the corpus spans the last 7 days;`);
    log('   the eval runner (watch mode) will flag the v2 pass-rate regression');
    log('   on `no-refusal` within one cycle (or run `pnpm eval:run` once).');
  } finally {
    await ch.close();
    await pool.end();
  }
}

export async function resetDemo(): Promise<void> {
  await seedDemo({ force: true });
}
