import { type ClickHouseClient, createClient } from '@clickhouse/client';

/** A trace as shown in the dashboard: one row aggregated from its spans. */
export interface Trace {
  traceId: string;
  model: string;
  /** Variant per DECISIONS.md D12: tagged prompt version, else the model. */
  variant: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  status: string;
  spanCount: number;
  startTime: string;
}

/** Filters for the trace list; every field is optional (absent = no filter). */
export interface TraceFilters {
  /** Exact trace id (from the search box or an eval drill-down link). */
  traceId?: string;
  /** Trace must contain a span with this request model. */
  model?: string;
  /** 'error' = at least one ERROR span; 'ok' = none. */
  status?: 'ok' | 'error';
  /** Trace variant (prompt version, else model) must equal this. */
  variant?: string;
  /** Only traces started in the last N hours. */
  hours?: number;
  /** Minimum total trace cost in USD. */
  minCostUsd?: number;
  /** Minimum whole-trace latency in milliseconds. */
  minLatencyMs?: number;
}

/** Shape returned by ClickHouse (JSONEachRow): 64-bit ints arrive as strings. */
interface RawTraceRow {
  trace_id: string;
  model: string;
  variant: string;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_usd: number;
  latency_ms: number;
  status: string;
  span_count: number;
  started_at: string;
}

let client: ClickHouseClient | undefined;

/** Shared module-level client: server components run per-request, reuse one connection pool. */
export function getClient(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      database: process.env.CLICKHOUSE_DATABASE ?? 'tracebloom',
      username: process.env.CLICKHOUSE_USER ?? 'default',
      password: process.env.CLICKHOUSE_PASSWORD ?? '',
    });
  }
  return client;
}

// Span-level predicates (time window, trace id) go in WHERE so partition/index
// pruning applies; trace-level predicates (model containment, status, variant,
// cost/latency floors) go in HAVING so aggregates always cover the WHOLE trace
// a model filter in WHERE would silently drop the other spans' tokens/cost.
function buildTraceListQuery(filters: TraceFilters): string {
  const where: string[] = [];
  if (filters.hours !== undefined) {
    where.push('start_time >= now() - INTERVAL {hours:UInt32} HOUR');
  }
  if (filters.traceId !== undefined) {
    where.push('trace_id = {traceId:String}');
  }

  const having: string[] = [];
  if (filters.model !== undefined) {
    having.push('countIf(request_model = {model:String}) > 0');
  }
  if (filters.status === 'error') {
    having.push("status = 'ERROR'");
  } else if (filters.status === 'ok') {
    having.push("status = 'OK'");
  }
  if (filters.variant !== undefined) {
    having.push('variant = {variant:String}');
  }
  if (filters.minCostUsd !== undefined) {
    having.push('cost_usd >= {minCostUsd:Float64}');
  }
  if (filters.minLatencyMs !== undefined) {
    having.push('latency_ms >= {minLatencyMs:Float64}');
  }

  return `
  SELECT
    trace_id,
    argMax(request_model, start_time)                                              AS model,
    -- Variant per DECISIONS.md D12: any tagged gen_ai.prompt.version in the
    -- trace (read-time JSONExtract; the column is not promoted), else the model.
    coalesce(
      nullIf(anyIf(
        JSONExtractString(attributes_json, 'gen_ai.prompt.version'),
        JSONExtractString(attributes_json, 'gen_ai.prompt.version') != ''
      ), ''),
      argMax(request_model, start_time)
    )                                                                              AS variant,
    toString(sum(input_tokens))                                                    AS input_tokens,
    toString(sum(output_tokens))                                                   AS output_tokens,
    toString(sum(total_tokens))                                                    AS total_tokens,
    sum(cost_usd)                                                                  AS cost_usd,
    (toUnixTimestamp64Nano(max(end_time)) - toUnixTimestamp64Nano(min(start_time))) / 1e6 AS latency_ms,
    if(countIf(status_code = 'ERROR') > 0, 'ERROR', 'OK')                          AS status,
    toUInt32(count())                                                              AS span_count,
    -- NB: this alias must NOT be named start_time. ClickHouse's analyzer would let
    -- such an alias shadow the start_time column inside toUnixTimestamp64Nano(min(...))
    -- above, resolving it to this String and erroring. Keep the name distinct.
    toString(max(start_time))                                                      AS started_at
  FROM tracebloom.spans
  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
  GROUP BY trace_id
  ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
  ORDER BY max(start_time) DESC
  LIMIT {limit:UInt32}
`;
}

/** Most recent traces matching the filters, newest first. */
export async function recentTraces(filters: TraceFilters = {}, limit = 50): Promise<Trace[]> {
  const resultSet = await getClient().query({
    query: buildTraceListQuery(filters),
    query_params: {
      limit,
      hours: filters.hours ?? 0,
      traceId: filters.traceId ?? '',
      model: filters.model ?? '',
      variant: filters.variant ?? '',
      minCostUsd: filters.minCostUsd ?? 0,
      minLatencyMs: filters.minLatencyMs ?? 0,
    },
    format: 'JSONEachRow',
  });
  const rows = await resultSet.json<RawTraceRow>();
  return rows.map((row) => ({
    traceId: row.trace_id,
    model: row.model,
    variant: row.variant,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    status: row.status,
    spanCount: row.span_count,
    startTime: row.started_at,
  }));
}

/** Distinct request models seen recently — options for the model filter. */
export async function recentModels(days = 30): Promise<string[]> {
  const resultSet = await getClient().query({
    query: `
      SELECT DISTINCT request_model
      FROM tracebloom.spans
      WHERE request_model != '' AND start_time >= now() - INTERVAL {days:UInt32} DAY
      ORDER BY request_model ASC
      LIMIT 100
    `,
    query_params: { days },
    format: 'JSONEachRow',
  });
  const rows = await resultSet.json<{ request_model: string }>();
  return rows.map((row) => row.request_model);
}
