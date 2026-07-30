/**
 * The eval runner orchestrator. For each enabled eval it: picks a bounded window
 * of candidate spans, applies deterministic sampling, skips spans already scored
 * (idempotency), reconstructs input/output, scores unique contents once (cache),
 * writes results, advances the watermark, and runs regression detection.
 *
 * Runs entirely out-of-band against landed spans; a failure in one eval is
 * caught so it can never take down the others or the loop (decision #3/#4).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  type Database,
  type EvalDefinition,
  evalDefinitions,
  evalRegressions,
  evalState,
} from '@tracebloom/db';
import type { JudgeClient } from '@tracebloom/eval';
import { contentHash, type EvalInput, type EvalOutcome } from '@tracebloom/eval';
import { and, eq, gt } from 'drizzle-orm';
import {
  type EvalResultRow,
  fetchContentCache,
  fetchExistingSpanIds,
  fetchSpanEvents,
  fetchVariantStats,
  insertEvalResults,
  selectCandidateSpans,
} from './clickhouse.js';
import { mapWithConcurrency } from './concurrency.js';
import type { RunnerConfig } from './env.js';
import { buildEvaluator } from './evaluators.js';
import { JUDGE_SERVICE_NAME } from './judge-client.js';
import { detectRegressions } from './regression.js';
import { buildResultRow, buildRowFromCache, type RowParams } from './results.js';
import { promoteSdkEvaluations } from './sdk-results.js';
import { computeVariant, reconstructIO, sampleDecision, toEvaluatedSpan } from './spans.js';
import { postWebhook, toWebhookPayload } from './webhook.js';

export type Logger = (message: string, meta?: Record<string, unknown>) => void;

export interface RunnerDeps {
  ch: ClickHouseClient;
  db: Database;
  config: RunnerConfig;
  judgeClient?: JudgeClient;
  now?: () => Date;
  logger?: Logger;
}

export interface EvalRunSummary {
  evalId: string;
  evalName: string;
  scanned: number;
  scored: number;
  cached: number;
  skippedExisting: number;
  errors: number;
  regressions: number;
  skipped?: string;
}

const noop: Logger = () => {};

/** Parse ClickHouse `toString(DateTime64(9))` (`YYYY-MM-DD HH:MM:SS.fffffffff`, UTC) to a Date. */
function parseChDateTime(value: string): Date {
  const iso = value.replace(' ', 'T').replace(/(\.\d{3})\d*$/, '$1');
  return new Date(`${iso}Z`);
}

interface Candidate {
  input: EvalInput;
  variant: string;
  hash: string;
  rowParams: RowParams;
}

/** Run every enabled eval once. Never throws; per-eval failures are captured. */
export async function runOnce(deps: RunnerDeps): Promise<EvalRunSummary[]> {
  const log = deps.logger ?? noop;

  // Promote SDK-recorded gen_ai.evaluation.result events into eval_results
  // (idempotent; see sdk-results.ts). A failure here must not block the
  // definition-driven evals below.
  try {
    const now = (deps.now ?? (() => new Date()))();
    const promoted = await promoteSdkEvaluations(
      deps.ch,
      new Date(now.getTime() - deps.config.lookbackMs),
      now,
      deps.config.batchLimit,
    );
    if (promoted > 0) {
      log('promoted sdk-recorded evaluations', { promoted });
    }
  } catch (error) {
    log('sdk evaluation promotion failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const enabled = await deps.db
    .select()
    .from(evalDefinitions)
    .where(eq(evalDefinitions.enabled, true));

  const summaries: EvalRunSummary[] = [];
  for (const def of enabled) {
    try {
      summaries.push(await runEval(deps, def));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('eval failed', { eval: def.name, error: message });
      summaries.push({
        evalId: def.id,
        evalName: def.name,
        scanned: 0,
        scored: 0,
        cached: 0,
        skippedExisting: 0,
        errors: 0,
        regressions: 0,
        skipped: message,
      });
    }
  }
  return summaries;
}

/** Run a single eval definition against the current window of spans. */
export async function runEval(deps: RunnerDeps, def: EvalDefinition): Promise<EvalRunSummary> {
  const { ch, db, config } = deps;
  const log = deps.logger ?? noop;
  const now = (deps.now ?? (() => new Date()))();

  const summary: EvalRunSummary = {
    evalId: def.id,
    evalName: def.name,
    scanned: 0,
    scored: 0,
    cached: 0,
    skippedExisting: 0,
    errors: 0,
    regressions: 0,
  };

  // Build the evaluator up front so a bad config / missing judge fails fast.
  const built = buildEvaluator(def, deps.judgeClient);

  // Window: from the watermark (minus a small overlap) to now, or a lookback on
  // the first run. The overlap is re-scanned but the idempotency check dedups it.
  const [state] = await db.select().from(evalState).where(eq(evalState.evalId, def.id)).limit(1);
  const since = state?.watermark
    ? new Date(state.watermark.getTime() - config.watermarkOverlapMs)
    : new Date(now.getTime() - config.lookbackMs);

  const rows = await selectCandidateSpans(
    ch,
    def.selector,
    since,
    now,
    config.batchLimit,
    JUDGE_SERVICE_NAME,
  );
  summary.scanned = rows.length;
  if (rows.length === 0) {
    await runRegressionPass(deps, def, built.evaluationName, now, summary);
    return summary;
  }

  // Advance the watermark to the newest scanned span regardless of sampling, so
  // an idle eval doesn't rescan the same range forever.
  const maxStart = rows.reduce<Date>((max, r) => {
    const t = parseChDateTime(r.span_start_time);
    return t > max ? t : max;
  }, new Date(0));

  // Deterministic sampling, then drop spans already scored for this version.
  const sampled = rows.filter((r) => sampleDecision(r.span_id, def.selector.samplingRate));
  const existing = await fetchExistingSpanIds(
    ch,
    def.id,
    def.version,
    sampled.map((r) => r.span_id),
  );
  const fresh = sampled.filter((r) => !existing.has(r.span_id));
  summary.skippedExisting = sampled.length - fresh.length;

  if (fresh.length > 0) {
    const events = await fetchSpanEvents(
      ch,
      fresh.map((r) => r.span_id),
    );

    const candidates: Candidate[] = [];
    for (const row of fresh) {
      const span = toEvaluatedSpan(row);
      const io = reconstructIO(events.get(row.span_id) ?? []);
      // No captured content means nothing to evaluate; skip rather than score noise.
      if (io.input === '' && io.output === '') {
        continue;
      }
      const input: EvalInput = { input: io.input, output: io.output, span };
      const hash = contentHash(def.version, input);
      const variant = computeVariant(span.promptVersion, span.requestModel);
      candidates.push({
        input,
        variant,
        hash,
        rowParams: {
          evalId: def.id,
          evalVersion: def.version,
          evaluatorType: def.type,
          evaluationName: built.evaluationName,
          span,
          variant,
          contentHash: hash,
        },
      });
    }

    // Reuse prior successful scores for identical content (skip re-scoring).
    const uniqueHashes = [...new Set(candidates.map((c) => c.hash))];
    const cache = await fetchContentCache(ch, def.id, def.version, uniqueHashes);

    // Score each unique, uncached content exactly once under bounded concurrency.
    const toScore = uniqueHashes.filter((h) => !cache.has(h));
    const repByHash = new Map<string, Candidate>();
    for (const c of candidates) {
      if (!repByHash.has(c.hash)) {
        repByHash.set(c.hash, c);
      }
    }
    const outcomes = new Map<string, EvalOutcome>();
    await mapWithConcurrency(toScore, config.concurrency, async (hash) => {
      const rep = repByHash.get(hash);
      if (!rep) {
        return;
      }
      // Evaluators never throw, but guard anyway so one bad span can't abort the run.
      try {
        outcomes.set(hash, await built.evaluator.evaluate(rep.input, built.config));
      } catch (error) {
        outcomes.set(hash, {
          score: 0,
          passed: false,
          errorType: error instanceof Error ? error.name : '_OTHER',
          reason: error instanceof Error ? error.message : 'evaluator threw',
        });
      }
    });

    const resultRows: EvalResultRow[] = candidates.map((c) => {
      const cached = cache.get(c.hash);
      if (cached) {
        summary.cached += 1;
        return buildRowFromCache(c.rowParams, cached);
      }
      const outcome = outcomes.get(c.hash) ?? {
        score: 0,
        passed: false,
        errorType: '_OTHER',
        reason: 'no outcome produced',
      };
      if (outcome.errorType) {
        summary.errors += 1;
      }
      return buildResultRow(c.rowParams, outcome);
    });

    await insertEvalResults(ch, resultRows);
    summary.scored = resultRows.length;
    log('eval scored spans', {
      eval: def.name,
      scored: summary.scored,
      cached: summary.cached,
      errors: summary.errors,
    });
  }

  // Persist the watermark so the next run starts just above this batch.
  await db
    .insert(evalState)
    .values({ evalId: def.id, watermark: maxStart, updatedAt: now })
    .onConflictDoUpdate({
      target: evalState.evalId,
      set: { watermark: maxStart, updatedAt: now },
    });

  await runRegressionPass(deps, def, built.evaluationName, now, summary);
  return summary;
}

/** Compute variant stats over the window, detect + persist regressions, alert. */
async function runRegressionPass(
  deps: RunnerDeps,
  def: EvalDefinition,
  evaluationName: string,
  now: Date,
  summary: EvalRunSummary,
): Promise<void> {
  const { ch, db, config } = deps;
  const log = deps.logger ?? noop;
  const windowStart = new Date(now.getTime() - config.regressionWindowMs);

  const stats = await fetchVariantStats(ch, def.id, def.version, windowStart, now);
  const regressions = detectRegressions(stats, {
    minSamples: config.regressionMinSamples,
    meanScoreDrop: config.meanScoreDropThreshold,
    passRateDrop: config.passRateDropThreshold,
    baselineVariant: config.baselineVariant,
  });
  if (regressions.length === 0) {
    return;
  }

  // De-dup against signals already raised this window for the same variant+metric.
  const recent = await db
    .select()
    .from(evalRegressions)
    .where(and(eq(evalRegressions.evalId, def.id), gt(evalRegressions.detectedAt, windowStart)));
  const seen = new Set(recent.map((r) => `${r.variant}:${r.metric}`));

  for (const regression of regressions) {
    if (seen.has(`${regression.variant}:${regression.metric}`)) {
      continue;
    }
    const [inserted] = await db
      .insert(evalRegressions)
      .values({
        evalId: def.id,
        metric: regression.metric,
        variant: regression.variant,
        baselineVariant: regression.baselineVariant,
        baselineValue: regression.baselineValue,
        currentValue: regression.currentValue,
        delta: regression.delta,
        threshold: regression.threshold,
        sampleCount: regression.sampleCount,
        windowStart,
        windowEnd: now,
      })
      .returning();
    summary.regressions += 1;
    log('regression detected', {
      eval: def.name,
      metric: regression.metric,
      variant: regression.variant,
      delta: regression.delta,
    });

    if (inserted && config.webhookUrl) {
      try {
        await postWebhook(config.webhookUrl, toWebhookPayload(evaluationName, inserted));
        await db
          .update(evalRegressions)
          .set({ notified: true })
          .where(eq(evalRegressions.id, inserted.id));
      } catch (error) {
        log('webhook failed', {
          eval: def.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
