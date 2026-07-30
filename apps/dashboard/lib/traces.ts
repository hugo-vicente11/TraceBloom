/**
 * Data access for the trace viewer.
 *
 * Two hard rules (see DECISIONS.md D13/D14):
 * - ONE ClickHouse query fetches every span of a trace (lean columns only —
 *   no attributes_json, no content). No per-span round trips, ever.
 * - Prompt/response content lives in span *events* and is loaded lazily by
 *   `getSpanDetail` only when a span is opened, never for a whole trace.
 *
 * Eval scores for the trace come from one additional constant query against
 * `eval_results` (a different table), issued in parallel with the span query.
 */

import { getClient } from './clickhouse';
import type { LiveCursor } from './live';

/** Spans are capped per trace so a runaway trace cannot flood the browser. */
export const TRACE_SPAN_CAP = 10_000;

/** Events are capped per span; a span with more than this is pathological. */
const SPAN_EVENT_CAP = 500;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/**
 * A trace with no root span but ingest activity within this window counts as
 * "running" (the root arrives last: see DECISIONS.md D22). Past the window a
 * rootless trace is treated as dead (crashed agent / dropped root) and renders
 * with the M3 orphan handling instead of waiting forever.
 */
export const RUNNING_STALE_MS = 10 * 60 * 1000;

/** Lowercase-hex trace id per DECISIONS.md D4 (32 chars). */
export function isValidTraceId(id: string): boolean {
  return TRACE_ID_RE.test(id);
}

/** Lowercase-hex span id per DECISIONS.md D4 (16 chars). */
export function isValidSpanId(id: string): boolean {
  return SPAN_ID_RE.test(id);
}

/** One span of a trace, as needed by the tree + waterfall (lean payload). */
export interface TraceSpan {
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  statusCode: string;
  statusMessage: string;
  serviceName: string;
  operationName: string;
  provider: string;
  requestModel: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Start offset from the trace's first span start, in nanoseconds. */
  startOffsetNs: number;
  durationNs: number;
  /** `gen_ai.tool.name` when this is a tool-execution span, else ''. */
  toolName: string;
  /** `gen_ai.prompt.version` (variant label) when tagged, else ''. */
  promptVersion: string;
  /** `tracebloom.retry.attempt`; 0 when unset, >= 2 marks a retry. */
  retryAttempt: number;
  /** When the row landed in ClickHouse (unix ms) — cursor + replay ordering. */
  ingestedMs: number;
}

/** Whole-trace aggregates for the viewer header. */
export interface TraceSummary {
  traceId: string;
  /** ISO timestamp of the earliest span start (ms precision). */
  startTime: string;
  durationNs: number;
  spanCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  serviceNames: string[];
  models: string[];
}

/** An eval result attached to one span (latest eval version per eval x span). */
export interface SpanEvalResult {
  spanId: string;
  evalId: string;
  evaluationName: string;
  evalVersion: number;
  scoreValue: number;
  scoreLabel: string;
  passed: boolean;
  explanation: string;
  errorType: string;
  evaluatorType: string;
  /** When the result row landed (unix ms). Set on live/delta reads. */
  evaluatedMs?: number;
}

export interface TraceDetail {
  trace: TraceSummary;
  spans: TraceSpan[];
  evalResults: SpanEvalResult[];
  /** True when the trace has more spans than TRACE_SPAN_CAP and was cut off. */
  truncated: boolean;
  /** Resume point for the live stream: watermarks over this snapshot. */
  cursor: LiveCursor;
  /** Absolute unix ns of the earliest span (offset anchor), decimal string. */
  anchorStartNs: string;
  /** No root span yet + recent ingest activity: the trace is still running. */
  running: boolean;
}

/** Raw ClickHouse row shape (JSONEachRow: UInt64/Int64 arrive as strings). */
interface RawSpanRow {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  status_code: string;
  status_message: string;
  service_name: string;
  operation_name: string;
  provider: string;
  request_model: string;
  response_model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  start_ns: string;
  duration_ns: string;
  tool_name: string;
  prompt_version: string;
  retry_attempt: number;
  ingested_ms: string;
}

// The single per-trace span query. The bloom-filter index on trace_id keeps
// this cheap without scanning every part; `LIMIT 1 BY span_id` collapses the
// duplicate rows a collector retry can produce (spans is a plain MergeTree).
// tool name / prompt version / retry attempt are unpromoted attributes,
// extracted at read time per DECISIONS.md D12.
const TRACE_SPANS_QUERY = `
  SELECT
    span_id,
    parent_span_id,
    name,
    kind,
    status_code,
    status_message,
    service_name,
    operation_name,
    provider,
    request_model,
    response_model,
    input_tokens,
    output_tokens,
    total_tokens,
    cost_usd,
    toString(toUnixTimestamp64Nano(start_time))                             AS start_ns,
    toString(duration_ns)                                                   AS duration_ns,
    JSONExtractString(attributes_json, 'gen_ai.tool.name')                  AS tool_name,
    JSONExtractString(attributes_json, 'gen_ai.prompt.version')             AS prompt_version,
    toUInt32(JSONExtractUInt(attributes_json, 'tracebloom.retry.attempt'))  AS retry_attempt,
    toString(toUnixTimestamp64Milli(ingested_at))                           AS ingested_ms
  FROM tracebloom.spans
  WHERE trace_id = {traceId:String}
  ORDER BY start_time ASC, span_id ASC
  LIMIT 1 BY span_id
  LIMIT {cap:UInt32}
`;

// Latest eval version per (eval, span): a config edit bumps eval_version
// (DECISIONS.md D9) and the viewer shows only the current version's result.
const TRACE_EVALS_QUERY = `
  SELECT
    span_id,
    eval_id,
    evaluation_name,
    eval_version,
    score_value,
    score_label,
    passed,
    explanation,
    error_type,
    evaluator_type,
    toString(toUnixTimestamp64Milli(evaluated_at)) AS evaluated_ms
  FROM tracebloom.eval_results FINAL
  WHERE trace_id = {traceId:String}
  ORDER BY eval_version DESC
  LIMIT 1 BY eval_id, span_id
`;

export interface RawEvalRow {
  span_id: string;
  eval_id: string;
  evaluation_name: string;
  eval_version: number;
  score_value: number;
  score_label: string;
  passed: number;
  explanation: string;
  error_type: string;
  evaluator_type: string;
  evaluated_ms: string;
}

/** Map a raw eval row to the shared shape (also used by the delta queries). */
export function mapEvalRow(r: RawEvalRow): SpanEvalResult {
  return {
    spanId: r.span_id,
    evalId: r.eval_id,
    evaluationName: r.evaluation_name,
    evalVersion: r.eval_version,
    scoreValue: r.score_value,
    scoreLabel: r.score_label,
    passed: r.passed === 1,
    explanation: r.explanation,
    errorType: r.error_type,
    evaluatorType: r.evaluator_type,
    evaluatedMs: Number(r.evaluated_ms),
  };
}

async function queryTraceSpans(traceId: string): Promise<RawSpanRow[]> {
  const rs = await getClient().query({
    query: TRACE_SPANS_QUERY,
    // +1 over the cap so we can tell "exactly at cap" from "truncated".
    query_params: { traceId, cap: TRACE_SPAN_CAP + 1 },
    format: 'JSONEachRow',
  });
  return rs.json<RawSpanRow>();
}

async function queryTraceEvals(
  traceId: string,
): Promise<{ results: SpanEvalResult[]; evalMs: number }> {
  const rs = await getClient().query({
    query: TRACE_EVALS_QUERY,
    query_params: { traceId },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<RawEvalRow>();
  let evalMs = 0;
  for (const row of rows) {
    evalMs = Math.max(evalMs, Number(row.evaluated_ms));
  }
  return { results: rows.map(mapEvalRow), evalMs };
}

/**
 * Fetch everything the trace page needs: all spans (one query), the trace's
 * eval results (one parallel query), and computed whole-trace aggregates.
 * Returns undefined when no spans exist for the id.
 */
export async function getTraceDetail(traceId: string): Promise<TraceDetail | undefined> {
  const [rawSpans, evals] = await Promise.all([queryTraceSpans(traceId), queryTraceEvals(traceId)]);
  if (rawSpans.length === 0) {
    return undefined;
  }
  const evalResults = evals.results;

  const truncated = rawSpans.length > TRACE_SPAN_CAP;
  const rows = truncated ? rawSpans.slice(0, TRACE_SPAN_CAP) : rawSpans;

  // Absolute unix nanos exceed 2^53, so offsets are computed with BigInt and
  // only the (small) deltas are handed to JS numbers.
  const startsNs = rows.map((r) => BigInt(r.start_ns));
  let minStart = startsNs[0] ?? 0n;
  for (const value of startsNs) {
    if (value < minStart) {
      minStart = value;
    }
  }

  const spans: TraceSpan[] = rows.map((r, i) => ({
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    name: r.name,
    kind: r.kind,
    statusCode: r.status_code,
    statusMessage: r.status_message,
    serviceName: r.service_name,
    operationName: r.operation_name,
    provider: r.provider,
    requestModel: r.request_model,
    responseModel: r.response_model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    startOffsetNs: Number((startsNs[i] ?? minStart) - minStart),
    durationNs: Number(r.duration_ns),
    toolName: r.tool_name,
    promptVersion: r.prompt_version,
    retryAttempt: r.retry_attempt,
    ingestedMs: Number(r.ingested_ms),
  }));

  let endNs = 0;
  let errorCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let spanMs = 0;
  let rootSeen = false;
  const serviceNames = new Set<string>();
  const models = new Set<string>();
  for (const span of spans) {
    endNs = Math.max(endNs, span.startOffsetNs + span.durationNs);
    if (span.statusCode === 'ERROR') {
      errorCount += 1;
    }
    inputTokens += span.inputTokens;
    outputTokens += span.outputTokens;
    totalTokens += span.totalTokens;
    costUsd += span.costUsd;
    spanMs = Math.max(spanMs, span.ingestedMs);
    if (span.parentSpanId === '') {
      rootSeen = true;
    }
    if (span.serviceName) {
      serviceNames.add(span.serviceName);
    }
    if (span.requestModel) {
      models.add(span.requestModel);
    }
  }

  const trace: TraceSummary = {
    traceId,
    startTime: new Date(Number(minStart / 1_000_000n)).toISOString(),
    durationNs: endNs,
    spanCount: spans.length,
    errorCount,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    serviceNames: [...serviceNames].sort(),
    models: [...models].sort(),
  };

  return {
    trace,
    spans,
    evalResults,
    truncated,
    cursor: { spanMs, evalMs: evals.evalMs },
    anchorStartNs: minStart.toString(),
    // The root span ends (and therefore arrives) last, so "no root yet" means
    // running: unless ingest has been quiet long enough to call the trace dead.
    running: !rootSeen && Date.now() - spanMs < RUNNING_STALE_MS,
  };
}

/** One span event (content message, choice, or exception). */
export interface SpanEvent {
  index: number;
  name: string;
  timestamp: string;
  /** Parsed JSON body when possible, else the raw string. */
  body: Record<string, unknown> | string;
}

/** Full detail for one span: complete attributes plus its content events. */
export interface SpanDetail {
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  statusCode: string;
  statusMessage: string;
  serviceName: string;
  scopeName: string;
  operationName: string;
  provider: string;
  requestModel: string;
  responseModel: string;
  responseId: string;
  finishReasons: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  startTime: string;
  durationNs: number;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  events: SpanEvent[];
}

interface RawSpanDetailRow {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  status_code: string;
  status_message: string;
  service_name: string;
  scope_name: string;
  operation_name: string;
  provider: string;
  request_model: string;
  response_model: string;
  response_id: string;
  finish_reasons: string[];
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  start_time: string;
  duration_ns: string;
  attributes_json: string;
  resource_attributes_json: string;
}

interface RawEventRow {
  event_index: number;
  name: string;
  timestamp: string;
  body: string;
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseEventBody(body: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through: keep a non-JSON body verbatim.
  }
  return body;
}

/**
 * Lazily fetch one span's full attributes and content events. Called only
 * when a span is opened in the viewer: never in bulk for a trace. Both
 * queries are constant (one span row, that span's events) and run in parallel.
 */
export async function getSpanDetail(
  traceId: string,
  spanId: string,
): Promise<SpanDetail | undefined> {
  const client = getClient();
  const [spanRs, eventsRs] = await Promise.all([
    client.query({
      // Newest ingested row wins if a collector retry duplicated the span.
      query: `
        SELECT
          span_id, parent_span_id, name, kind, status_code, status_message,
          service_name, scope_name, operation_name, provider,
          request_model, response_model, response_id, finish_reasons,
          input_tokens, output_tokens, total_tokens, cost_usd,
          toString(start_time)  AS start_time,
          toString(duration_ns) AS duration_ns,
          attributes_json, resource_attributes_json
        FROM tracebloom.spans
        WHERE trace_id = {traceId:String} AND span_id = {spanId:String}
        ORDER BY ingested_at DESC
        LIMIT 1
      `,
      query_params: { traceId, spanId },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT event_index, name, toString(timestamp) AS timestamp, body
        FROM tracebloom.span_events
        WHERE trace_id = {traceId:String} AND span_id = {spanId:String}
        ORDER BY event_index ASC
        LIMIT 1 BY event_index
        LIMIT {cap:UInt32}
      `,
      query_params: { traceId, spanId, cap: SPAN_EVENT_CAP },
      format: 'JSONEachRow',
    }),
  ]);

  const spanRows = await spanRs.json<RawSpanDetailRow>();
  const row = spanRows[0];
  if (!row) {
    return undefined;
  }
  const eventRows = await eventsRs.json<RawEventRow>();

  return {
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    statusCode: row.status_code,
    statusMessage: row.status_message,
    serviceName: row.service_name,
    scopeName: row.scope_name,
    operationName: row.operation_name,
    provider: row.provider,
    requestModel: row.request_model,
    responseModel: row.response_model,
    responseId: row.response_id,
    finishReasons: row.finish_reasons,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    startTime: row.start_time,
    durationNs: Number(row.duration_ns),
    attributes: parseJsonObject(row.attributes_json),
    resourceAttributes: parseJsonObject(row.resource_attributes_json),
    events: eventRows.map((e) => ({
      index: e.event_index,
      name: e.name,
      timestamp: e.timestamp,
      body: parseEventBody(e.body),
    })),
  };
}
