/**
 * Data access for the dashboard's Evals view. Eval *definitions* and regression
 * signals live in Postgres (via @tracebloom/db); scored results live in
 * ClickHouse. This module owns both, plus the small aggregations the charts need.
 */

import { createClient } from '@clickhouse/client';
import {
  createDb,
  type Database,
  type EvalDefinition,
  type EvalRegression,
  type EvalSelector,
  type EvalType,
  evalDefinitions,
  evalRegressions,
} from '@tracebloom/db';
import { validateConfig } from '@tracebloom/eval';
import { desc, eq, sql } from 'drizzle-orm';

// Module-level singletons: Next.js server components run per-request, so reuse
// one pool / client rather than opening a connection on every render.
let dbHandle: { db: Database; end: () => Promise<void> } | undefined;
function db(): Database {
  if (!dbHandle) {
    const { db: d, pool } = createDb();
    dbHandle = { db: d, end: () => pool.end() };
  }
  return dbHandle.db;
}

const chClient = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE ?? 'tracebloom',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
});

export type { EvalDefinition, EvalRegression, EvalSelector, EvalType };

/** Cheap Postgres connectivity check for /api/status. */
export async function pingConfigDb(): Promise<void> {
  await db().execute(sql`SELECT 1`);
}

export async function listEvalDefinitions(): Promise<EvalDefinition[]> {
  return db().select().from(evalDefinitions).orderBy(desc(evalDefinitions.createdAt));
}

export interface CreateEvalInput {
  name: string;
  type: EvalType;
  config: unknown;
  selector: EvalSelector;
  enabled: boolean;
}

/** Create an eval, validating its config against the evaluator type first. */
export async function createEvalDefinition(input: CreateEvalInput): Promise<EvalDefinition> {
  // Reuses the runner's validation so the UI can't persist a config the runner
  // would choke on. Throws a ConfigError with a helpful message on bad input.
  validateConfig(input.type, input.config);
  const [row] = await db()
    .insert(evalDefinitions)
    .values({
      name: input.name,
      type: input.type,
      config: input.config as Record<string, unknown>,
      selector: input.selector,
      enabled: input.enabled,
    })
    .returning();
  if (!row) {
    throw new Error('failed to create eval');
  }
  return row;
}

export async function setEvalEnabled(id: string, enabled: boolean): Promise<void> {
  await db()
    .update(evalDefinitions)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(evalDefinitions.id, id));
}

/** Update an eval's config, bumping its version so results are recomputed under a new key. */
export async function updateEvalConfig(id: string, config: unknown): Promise<void> {
  const existing = await getEvalDefinition(id);
  if (!existing) {
    throw new Error('eval not found');
  }
  validateConfig(existing.type, config);
  await db()
    .update(evalDefinitions)
    .set({
      config: config as Record<string, unknown>,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(evalDefinitions.id, id));
}

export async function getEvalDefinition(id: string): Promise<EvalDefinition | undefined> {
  const [row] = await db()
    .select()
    .from(evalDefinitions)
    .where(eq(evalDefinitions.id, id))
    .limit(1);
  return row;
}

export async function listRegressions(evalId: string): Promise<EvalRegression[]> {
  return db()
    .select()
    .from(evalRegressions)
    .where(eq(evalRegressions.evalId, evalId))
    .orderBy(desc(evalRegressions.detectedAt))
    .limit(50);
}

/** One point on the score-over-time chart: mean score for a UTC day. */
export interface ScorePoint {
  day: string;
  meanScore: number;
  sampleCount: number;
}

export async function scoreOverTime(
  evalId: string,
  version: number,
  days = 30,
): Promise<ScorePoint[]> {
  const rs = await chClient.query({
    query: `
      SELECT
        toString(toDate(span_start_time))  AS day,
        avg(score_value)                   AS mean_score,
        toString(count())                  AS sample_count
      FROM tracebloom.eval_results FINAL
      WHERE eval_id = {id:String} AND eval_version = {v:UInt32} AND error_type = ''
        AND span_start_time >= now() - INTERVAL {days:UInt32} DAY
      GROUP BY day ORDER BY day ASC`,
    query_params: { id: evalId, v: version, days },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ day: string; mean_score: number; sample_count: string }>();
  return rows.map((r) => ({
    day: r.day,
    meanScore: r.mean_score,
    sampleCount: Number(r.sample_count),
  }));
}

/** Aggregated stats for one variant over the comparison window. */
export interface VariantRow {
  variant: string;
  meanScore: number;
  passRate: number;
  sampleCount: number;
}

export async function variantComparison(
  evalId: string,
  version: number,
  days = 30,
): Promise<VariantRow[]> {
  const rs = await chClient.query({
    query: `
      SELECT
        variant,
        avg(score_value)       AS mean_score,
        sum(passed) / count()  AS pass_rate,
        toString(count())      AS sample_count
      FROM tracebloom.eval_results FINAL
      WHERE eval_id = {id:String} AND eval_version = {v:UInt32} AND error_type = ''
        AND span_start_time >= now() - INTERVAL {days:UInt32} DAY
      GROUP BY variant ORDER BY mean_score DESC`,
    query_params: { id: evalId, v: version, days },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{
    variant: string;
    mean_score: number;
    pass_rate: number;
    sample_count: string;
  }>();
  return rows.map((r) => ({
    variant: r.variant,
    meanScore: r.mean_score,
    passRate: r.pass_rate,
    sampleCount: Number(r.sample_count),
  }));
}

/** A single scored span for the drill-down list. */
export interface ScoredSpan {
  traceId: string;
  spanId: string;
  variant: string;
  score: number;
  label: string;
  passed: boolean;
  explanation: string;
  errorType: string;
  spanStartTime: string;
}

export async function recentScoredSpans(
  evalId: string,
  version: number,
  limit = 50,
): Promise<ScoredSpan[]> {
  const rs = await chClient.query({
    query: `
      SELECT
        trace_id, span_id, variant,
        score_value AS score, score_label AS label, passed,
        explanation, error_type,
        toString(span_start_time) AS span_start_time
      FROM tracebloom.eval_results FINAL
      WHERE eval_id = {id:String} AND eval_version = {v:UInt32}
      ORDER BY span_start_time DESC
      LIMIT {limit:UInt32}`,
    query_params: { id: evalId, v: version, limit },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{
    trace_id: string;
    span_id: string;
    variant: string;
    score: number;
    label: string;
    passed: number;
    explanation: string;
    error_type: string;
    span_start_time: string;
  }>();
  return rows.map((r) => ({
    traceId: r.trace_id,
    spanId: r.span_id,
    variant: r.variant,
    score: r.score,
    label: r.label,
    passed: r.passed === 1,
    explanation: r.explanation,
    errorType: r.error_type,
    spanStartTime: r.span_start_time,
  }));
}
