/**
 * Cursor-based delta reads for live traces (server only).
 *
 * One poll = two cheap, bounded queries: spans past the span watermark and
 * eval results past the eval watermark, both filtered to one trace_id (bloom
 * filter indexed): never a full-trace re-fetch. The bound is INCLUSIVE
 * (`>=`): the collector's writer stamps `ingested_at` with millisecond
 * precision, so consecutive batches can share a millisecond; re-reading the
 * boundary row(s) and letting the client merge by id is what guarantees
 * no-gaps-no-dupes without needing sub-ms watermarks. Visibility order
 * matches `ingested_at` order because the collector writes from a single
 * sequential task (DECISIONS.md D3/D21).
 */

import { getClient } from './clickhouse';
import type { LiveCursor, LiveDelta, LiveSpan } from './live';
import { mapEvalRow, type RawEvalRow } from './traces';

/**
 * Rows per delta poll are capped; a poll that hits the cap simply resumes
 * from its own watermark on the next tick (rows are ordered by ingested_at,
 * so the cursor never jumps past unseen rows).
 */
export const DELTA_SPAN_CAP = 2_000;
const DELTA_EVAL_CAP = 1_000;

// Same lean columns as the snapshot query (D13) plus the absolute start and
// the arrival watermark. Ordered by ingested_at so a capped read stays
// resumable; `LIMIT 1 BY span_id` collapses collector-retry duplicates.
const SPAN_DELTA_QUERY = `
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
    AND ingested_at >= fromUnixTimestamp64Milli({spanMs:Int64}, 'UTC')
  ORDER BY ingested_at ASC, span_id ASC
  LIMIT 1 BY span_id
  LIMIT {cap:UInt32}
`;

// Eval deltas are NOT collapsed to the latest version here: the client keeps
// the highest eval_version per (eval, span), so shipping every new row is
// both simpler and gap-free under the cap.
const EVAL_DELTA_QUERY = `
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
    AND evaluated_at >= fromUnixTimestamp64Milli({evalMs:Int64}, 'UTC')
  ORDER BY evaluated_at ASC
  LIMIT {cap:UInt32}
`;

interface RawDeltaSpanRow {
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

/** Signature of one delta poll — injected into the broker for testability. */
export type FetchDeltas = (traceId: string, cursor: LiveCursor) => Promise<LiveDelta>;

/**
 * Fetch everything that landed at or after the cursor for one trace. The
 * returned cursor is advanced to the highest watermark seen (unchanged
 * dimensions keep their input value).
 */
export async function fetchTraceDeltas(traceId: string, cursor: LiveCursor): Promise<LiveDelta> {
  const client = getClient();
  const [spanRs, evalRs] = await Promise.all([
    client.query({
      query: SPAN_DELTA_QUERY,
      query_params: { traceId, spanMs: cursor.spanMs, cap: DELTA_SPAN_CAP },
      format: 'JSONEachRow',
    }),
    client.query({
      query: EVAL_DELTA_QUERY,
      query_params: { traceId, evalMs: cursor.evalMs, cap: DELTA_EVAL_CAP },
      format: 'JSONEachRow',
    }),
  ]);
  const [spanRows, evalRows] = await Promise.all([
    spanRs.json<RawDeltaSpanRow>(),
    evalRs.json<RawEvalRow>(),
  ]);

  let spanMs = cursor.spanMs;
  let rootSeen = false;
  const spans: LiveSpan[] = spanRows.map((r) => {
    spanMs = Math.max(spanMs, Number(r.ingested_ms));
    if (r.parent_span_id === '') {
      rootSeen = true;
    }
    return {
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
      startNs: r.start_ns,
      durationNs: Number(r.duration_ns),
      toolName: r.tool_name,
      promptVersion: r.prompt_version,
      retryAttempt: r.retry_attempt,
      ingestedMs: Number(r.ingested_ms),
    };
  });

  let evalMs = cursor.evalMs;
  for (const row of evalRows) {
    evalMs = Math.max(evalMs, Number(row.evaluated_ms));
  }

  return {
    spans,
    evals: evalRows.map(mapEvalRow),
    cursor: { spanMs, evalMs },
    rootSeen,
  };
}
