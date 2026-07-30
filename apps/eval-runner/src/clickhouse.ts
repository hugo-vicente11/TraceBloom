/**
 * ClickHouse access for the runner: selecting candidate spans, reading their
 * content events, the idempotency/cache lookups, writing eval results, and the
 * per-variant aggregation that feeds regression detection.
 *
 * Everything here reads spans that have already landed and writes to a separate
 * table: the runner never touches the collector's ingestion path (decision #3).
 * Reuses the same official `@clickhouse/client` and env conventions as the rest
 * of the repo (decision #5).
 */

import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { EvalSelector } from '@tracebloom/db';
import type { VariantStats } from './regression.js';
import type { SpanEventRow, SpanRow } from './spans.js';

/** Format a Date for a ClickHouse `DateTime64` query parameter (UTC, no `T`/`Z`). */
function chDateTimeParam(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export function createEvalClickHouse(): ClickHouseClient {
  return createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE ?? 'tracebloom',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  });
}

/** A fully-materialized eval result row, ready to insert into `eval_results`. */
export interface EvalResultRow {
  eval_id: string;
  eval_version: number;
  trace_id: string;
  span_id: string;
  response_id: string;
  evaluation_name: string;
  score_value: number;
  score_label: string;
  passed: number;
  explanation: string;
  error_type: string;
  evaluator_type: string;
  request_model: string;
  operation_name: string;
  service_name: string;
  prompt_version: string;
  variant: string;
  content_hash: string;
  span_start_time: string;
  metadata_json: string;
}

/** A previously-stored successful result, reused from the content-hash cache. */
export interface CachedResult {
  score_value: number;
  score_label: string;
  passed: number;
  explanation: string;
}

/**
 * Select candidate gen_ai spans matching a selector within a time window. Only
 * spans with an operation name (i.e. LLM operations) are considered; the prompt
 * version is extracted from the lossless attributes JSON in SQL.
 */
export async function selectCandidateSpans(
  client: ClickHouseClient,
  selector: EvalSelector,
  since: Date,
  until: Date,
  limit: number,
  excludeService: string,
): Promise<SpanRow[]> {
  const conditions = [
    "operation_name != ''",
    'start_time > {since:DateTime64(9)}',
    'start_time <= {until:DateTime64(9)}',
    // Never evaluate the runner's own judge spans (they land like any gen_ai span).
    'service_name != {selfService:String}',
  ];
  const params: Record<string, unknown> = {
    since: chDateTimeParam(since),
    until: chDateTimeParam(until),
    selfService: excludeService,
    limit,
  };
  if (selector.serviceNames && selector.serviceNames.length > 0) {
    conditions.push('service_name IN {services:Array(String)}');
    params.services = selector.serviceNames;
  }
  if (selector.models && selector.models.length > 0) {
    conditions.push('request_model IN {models:Array(String)}');
    params.models = selector.models;
  }
  if (selector.operations && selector.operations.length > 0) {
    conditions.push('operation_name IN {operations:Array(String)}');
    params.operations = selector.operations;
  }

  const query = `
    SELECT
      trace_id,
      span_id,
      response_id,
      request_model,
      operation_name,
      service_name,
      toString(start_time) AS span_start_time,
      JSONExtractString(attributes_json, 'gen_ai.prompt.version') AS prompt_version,
      attributes_json
    FROM tracebloom.spans
    WHERE ${conditions.join(' AND ')}
    ORDER BY start_time ASC
    LIMIT {limit:UInt32}`;

  const rs = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  return rs.json<SpanRow>();
}

/** Fetch content events for a set of spans in one query, ordered per span. */
export async function fetchSpanEvents(
  client: ClickHouseClient,
  spanIds: string[],
): Promise<Map<string, SpanEventRow[]>> {
  const bySpan = new Map<string, SpanEventRow[]>();
  if (spanIds.length === 0) {
    return bySpan;
  }
  const rs = await client.query({
    query: `
      SELECT span_id, name, body
      FROM tracebloom.span_events
      WHERE span_id IN {ids:Array(String)}
      ORDER BY span_id, event_index ASC`,
    query_params: { ids: spanIds },
    format: 'JSONEachRow',
  });
  for (const row of await rs.json<SpanEventRow>()) {
    const list = bySpan.get(row.span_id);
    if (list) {
      list.push(row);
    } else {
      bySpan.set(row.span_id, [row]);
    }
  }
  return bySpan;
}

/** Span ids already scored for this eval version (the persistent idempotency check). */
export async function fetchExistingSpanIds(
  client: ClickHouseClient,
  evalId: string,
  evalVersion: number,
  spanIds: string[],
): Promise<Set<string>> {
  if (spanIds.length === 0) {
    return new Set();
  }
  const rs = await client.query({
    query: `
      SELECT DISTINCT span_id
      FROM tracebloom.eval_results
      WHERE eval_id = {eval_id:String} AND eval_version = {v:UInt32}
        AND span_id IN {ids:Array(String)}`,
    query_params: { eval_id: evalId, v: evalVersion, ids: spanIds },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ span_id: string }>();
  return new Set(rows.map((r) => r.span_id));
}

/**
 * Look up prior *successful* results by content hash so an identical output is
 * never re-scored (no repeat judge call). Errors are excluded so a transient
 * failure isn't cached as a permanent zero. See DECISIONS.md D10.
 */
export async function fetchContentCache(
  client: ClickHouseClient,
  evalId: string,
  evalVersion: number,
  hashes: string[],
): Promise<Map<string, CachedResult>> {
  const cache = new Map<string, CachedResult>();
  if (hashes.length === 0) {
    return cache;
  }
  const rs = await client.query({
    query: `
      SELECT content_hash, score_value, score_label, passed, explanation
      FROM tracebloom.eval_results FINAL
      WHERE eval_id = {eval_id:String} AND eval_version = {v:UInt32}
        AND error_type = '' AND content_hash IN {hashes:Array(String)}
      LIMIT 1 BY content_hash`,
    query_params: { eval_id: evalId, v: evalVersion, hashes },
    format: 'JSONEachRow',
  });
  for (const row of await rs.json<{ content_hash: string } & CachedResult>()) {
    cache.set(row.content_hash, {
      score_value: row.score_value,
      score_label: row.score_label,
      passed: row.passed,
      explanation: row.explanation,
    });
  }
  return cache;
}

/** A raw `gen_ai.evaluation.result` span event joined with its span's dimensions. */
export interface SdkEvaluationEventRow {
  trace_id: string;
  span_id: string;
  /** JSON-encoded event attributes (the D8 `gen_ai.evaluation.*` keys). */
  body: string;
  response_id: string;
  request_model: string;
  operation_name: string;
  service_name: string;
  span_start_time: string;
  prompt_version: string;
}

/**
 * Fetch SDK-recorded evaluation events (`recordEvaluation` /
 * `record_evaluation`) within a window, joined with their spans' promoted
 * dimensions. `ANY INNER JOIN` collapses collector-retry span duplicates
 * while keeping every event (a span may carry several eval names).
 */
export async function fetchSdkEvaluationEvents(
  client: ClickHouseClient,
  since: Date,
  until: Date,
  limit: number,
): Promise<SdkEvaluationEventRow[]> {
  const rs = await client.query({
    query: `
      SELECT
        e.trace_id AS trace_id,
        e.span_id AS span_id,
        e.body AS body,
        s.response_id AS response_id,
        s.request_model AS request_model,
        s.operation_name AS operation_name,
        s.service_name AS service_name,
        toString(s.start_time) AS span_start_time,
        JSONExtractString(s.attributes_json, 'gen_ai.prompt.version') AS prompt_version
      FROM tracebloom.span_events AS e
      ANY INNER JOIN tracebloom.spans AS s
        ON s.trace_id = e.trace_id AND s.span_id = e.span_id
      WHERE e.name = 'gen_ai.evaluation.result'
        AND e.timestamp > {since:DateTime64(9)}
        AND e.timestamp <= {until:DateTime64(9)}
      LIMIT {limit:UInt32}`,
    query_params: {
      since: chDateTimeParam(since),
      until: chDateTimeParam(until),
      limit,
    },
    format: 'JSONEachRow',
  });
  return rs.json<SdkEvaluationEventRow>();
}

/** Insert scored results. `evaluated_at` is defaulted server-side. */
export async function insertEvalResults(
  client: ClickHouseClient,
  rows: EvalResultRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await client.insert({ table: 'tracebloom.eval_results', values: rows, format: 'JSONEachRow' });
}

interface RawVariantStats {
  variant: string;
  mean_score: number;
  pass_rate: number;
  sample_count: string;
}

/** Per-variant mean score / pass rate / sample count over a window (errors excluded). */
export async function fetchVariantStats(
  client: ClickHouseClient,
  evalId: string,
  evalVersion: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<VariantStats[]> {
  const rs = await client.query({
    query: `
      SELECT
        variant,
        avg(score_value)                 AS mean_score,
        sum(passed) / count()            AS pass_rate,
        toString(count())                AS sample_count
      FROM tracebloom.eval_results FINAL
      WHERE eval_id = {eval_id:String} AND eval_version = {v:UInt32}
        AND error_type = ''
        AND span_start_time >= {start:DateTime64(9)}
        AND span_start_time < {end:DateTime64(9)}
      GROUP BY variant
      ORDER BY variant`,
    query_params: {
      eval_id: evalId,
      v: evalVersion,
      start: chDateTimeParam(windowStart),
      end: chDateTimeParam(windowEnd),
    },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<RawVariantStats>();
  return rows.map((r) => ({
    variant: r.variant,
    meanScore: r.mean_score,
    passRate: r.pass_rate,
    sampleCount: Number(r.sample_count),
  }));
}
