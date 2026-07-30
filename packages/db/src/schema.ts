/**
 * Postgres schema (Drizzle ORM). Postgres holds low-volume relational config —
 * projects and eval definitions: while high-volume telemetry (spans, eval
 * results) lives in ClickHouse. See DECISIONS.md / README for the storage split.
 */

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** A project groups telemetry and (later) evals. The minimal config entity for M1. */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL/CLI-friendly identifier, e.g. used to scope ingest in a later milestone. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Free-form project settings; typed at the application layer. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('projects_slug_idx').on(table.slug)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

/** Evaluator kind. `deterministic` runs rule checks; `llm_judge` calls a model. */
export type EvalType = 'deterministic' | 'llm_judge';

/**
 * Selector describing which spans an eval runs against. Persisted as JSON so the
 * runner and dashboard share one shape; validated at the application layer.
 * `samplingRate` is 0..1 and applied via a deterministic hash of the span id so
 * sampling is stable and idempotent across runs.
 */
export interface EvalSelector {
  serviceNames?: string[];
  models?: string[];
  operations?: string[];
  samplingRate: number;
}

/**
 * An eval definition. `version` is bumped whenever `config` changes so results
 * are recomputed under a new key (the runner's idempotency key includes it); old
 * results remain queryable under the old version. See DECISIONS.md D9.
 */
export const evalDefinitions = pgTable(
  'eval_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: text('type').$type<EvalType>().notNull(),
    /** Bumped by the application layer on every config change. */
    version: integer('version').notNull().default(1),
    /** Evaluator-specific configuration; shape depends on `type`. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Which spans to evaluate (+ sampling rate). */
    selector: jsonb('selector').$type<EvalSelector>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('eval_definitions_name_idx').on(table.name)],
);

export type EvalDefinition = typeof evalDefinitions.$inferSelect;
export type NewEvalDefinition = typeof evalDefinitions.$inferInsert;

/**
 * The runner's per-eval cursor. `watermark` is the newest evaluated span's start
 * time; the next run scans from just before it (with a small overlap the
 * idempotency check dedups) so scans stay bounded without missing late arrivals.
 */
export const evalState = pgTable('eval_state', {
  evalId: uuid('eval_id')
    .primaryKey()
    .references(() => evalDefinitions.id, { onDelete: 'cascade' }),
  watermark: timestamp('watermark', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EvalState = typeof evalState.$inferSelect;
export type NewEvalState = typeof evalState.$inferInsert;

/** Which score metric a regression is measured on. */
export type RegressionMetric = 'mean_score' | 'pass_rate';

/**
 * A persisted regression signal: a variant's mean score or pass rate dropped
 * beyond the configured threshold versus a baseline variant over a time window.
 * `notified` records whether the alerting webhook stub has fired for this signal.
 */
export const evalRegressions = pgTable(
  'eval_regressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evalId: uuid('eval_id')
      .notNull()
      .references(() => evalDefinitions.id, { onDelete: 'cascade' }),
    metric: text('metric').$type<RegressionMetric>().notNull(),
    variant: text('variant').notNull(),
    baselineVariant: text('baseline_variant').notNull(),
    baselineValue: doublePrecision('baseline_value').notNull(),
    currentValue: doublePrecision('current_value').notNull(),
    /** currentValue - baselineValue (negative for a regression). */
    delta: doublePrecision('delta').notNull(),
    /** The drop magnitude that triggered the signal. */
    threshold: doublePrecision('threshold').notNull(),
    sampleCount: integer('sample_count').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    notified: boolean('notified').notNull().default(false),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('eval_regressions_eval_id_idx').on(table.evalId, table.detectedAt)],
);

export type EvalRegression = typeof evalRegressions.$inferSelect;
export type NewEvalRegression = typeof evalRegressions.$inferInsert;
