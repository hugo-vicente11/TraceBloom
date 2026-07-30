/**
 * Currently-running traces for the trace list's live rail (server only).
 *
 * "Running" mirrors the trace page (D22): no root span landed yet AND ingest
 * activity within RUNNING_STALE_MS. Two-step shape so aggregates always
 * cover the whole trace: candidates are found first (rootless + recently
 * active), then aggregated: a WHERE-side activity filter would silently
 * drop older spans from the counts. Both passes are bounded to a recent
 * start_time window so the scan stays partition-pruned.
 *
 * Poll load is bounded by construction: results are cached in-process for
 * CACHE_TTL_MS, so any number of dashboard tabs polling the rail costs at
 * most one ClickHouse query per TTL.
 */

import { getClient } from './clickhouse';
import { RUNNING_STALE_MS } from './traces';

/** Ignore traces that started more than this long ago (scan bound). */
const LOOKBACK_HOURS = 6;
const MAX_RUNNING_TRACES = 20;
const CACHE_TTL_MS = 2_000;

export interface LiveTraceRow {
  traceId: string;
  service: string;
  model: string;
  spanCount: number;
  totalTokens: number;
  costUsd: number;
  errorCount: number;
  /** ISO start of the earliest span. */
  startTime: string;
  /** Unix ms of the newest ingested span (activity indicator). */
  lastActivityMs: number;
}

interface RawRunningRow {
  trace_id: string;
  service: string;
  model: string;
  span_count: number;
  total_tokens: string;
  cost_usd: number;
  error_count: string;
  started_iso: string;
  last_activity_ms: string;
}

const RUNNING_TRACES_QUERY = `
  WITH candidates AS (
    SELECT trace_id
    FROM tracebloom.spans
    WHERE start_time >= now() - INTERVAL {lookbackHours:UInt32} HOUR
    GROUP BY trace_id
    HAVING countIf(parent_span_id = '') = 0
       AND max(ingested_at) >= now64(3) - INTERVAL {activeSeconds:UInt32} SECOND
  )
  SELECT
    trace_id,
    coalesce(nullIf(anyIf(service_name, service_name != ''), ''), '')   AS service,
    argMax(request_model, start_time)                                   AS model,
    toUInt32(count())                                                   AS span_count,
    toString(sum(total_tokens))                                         AS total_tokens,
    sum(cost_usd)                                                       AS cost_usd,
    toString(countIf(status_code = 'ERROR'))                            AS error_count,
    concat(replaceOne(toString(min(start_time)), ' ', 'T'), 'Z')        AS started_iso,
    toString(toUnixTimestamp64Milli(max(ingested_at)))                  AS last_activity_ms
  FROM tracebloom.spans
  WHERE trace_id IN (SELECT trace_id FROM candidates)
    AND start_time >= now() - INTERVAL {lookbackHours:UInt32} HOUR
  GROUP BY trace_id
  ORDER BY min(start_time) DESC
  LIMIT {limit:UInt32}
`;

async function queryRunningTraces(): Promise<LiveTraceRow[]> {
  const rs = await getClient().query({
    query: RUNNING_TRACES_QUERY,
    query_params: {
      lookbackHours: LOOKBACK_HOURS,
      activeSeconds: Math.floor(RUNNING_STALE_MS / 1000),
      limit: MAX_RUNNING_TRACES,
    },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<RawRunningRow>();
  return rows.map((row) => ({
    traceId: row.trace_id,
    service: row.service,
    model: row.model,
    spanCount: row.span_count,
    totalTokens: Number(row.total_tokens),
    costUsd: row.cost_usd,
    errorCount: Number(row.error_count),
    startTime: row.started_iso,
    lastActivityMs: Number(row.last_activity_ms),
  }));
}

let cache: { at: number; result: Promise<LiveTraceRow[]> } | undefined;

/** Running traces, at most one ClickHouse query per CACHE_TTL_MS. */
export function runningTraces(): Promise<LiveTraceRow[]> {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_TTL_MS) {
    const result = queryRunningTraces();
    cache = { at: now, result };
    // A failed query must not poison the cache window.
    result.catch(() => {
      if (cache?.result === result) {
        cache = undefined;
      }
    });
  }
  return cache.result;
}
