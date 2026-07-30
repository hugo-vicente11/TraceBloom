/**
 * Promotion of SDK-recorded evaluation events into `eval_results`.
 *
 * Both SDKs expose an eval hook (`recordEvaluation` / `record_evaluation`)
 * that emits the canonical `gen_ai.evaluation.result` event onto a span (D8).
 * The collector stores those events in `span_events` untouched; this pass —
 * following the D12 pattern of promoting out-of-band instead of changing the
 * collector: materializes them into `eval_results` so SDK-recorded feedback
 * aggregates and renders exactly like engine-computed scores.
 *
 * Identity: `eval_id = 'sdk:<evaluation name>'` with `eval_version = 1` —
 * SDK hooks aren't versioned definitions, and the ReplacingMergeTree key
 * (eval_id, eval_version, span_id) makes re-promoting the same window
 * idempotent (re-runs collapse on merge).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  type EvalResultRow,
  fetchSdkEvaluationEvents,
  insertEvalResults,
  type SdkEvaluationEventRow,
} from './clickhouse.js';
import { computeVariant } from './spans.js';

/** eval_id namespace for SDK-recorded results (vs Postgres-defined evals). */
export const SDK_EVAL_ID_PREFIX = 'sdk:';

/** evaluator_type recorded for promoted SDK events. */
export const SDK_EVALUATOR_TYPE = 'sdk';

/** A span may pass without a label; scores at or above this count as passed. */
const PASS_THRESHOLD = 0.5;

/**
 * Map one raw event row to an `eval_results` row, or `undefined` when the
 * event body is malformed (no evaluation name): such events are skipped, not
 * fatal: promotion must tolerate hand-rolled emitters.
 */
export function toSdkResultRow(row: SdkEvaluationEventRow): EvalResultRow | undefined {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const name = body['gen_ai.evaluation.name'];
  if (typeof name !== 'string' || name === '') {
    return undefined;
  }
  const rawScore = body['gen_ai.evaluation.score.value'];
  const score = typeof rawScore === 'number' ? rawScore : 0;
  const label = body['gen_ai.evaluation.score.label'];
  const explanation = body['gen_ai.evaluation.explanation'];
  const errorType = body['error.type'];
  const errored = typeof errorType === 'string' && errorType !== '';

  return {
    eval_id: `${SDK_EVAL_ID_PREFIX}${name}`,
    eval_version: 1,
    trace_id: row.trace_id,
    span_id: row.span_id,
    response_id: row.response_id,
    evaluation_name: name,
    score_value: errored ? 0 : score,
    score_label: typeof label === 'string' ? label : '',
    passed: !errored && score >= PASS_THRESHOLD ? 1 : 0,
    explanation: typeof explanation === 'string' ? explanation : '',
    error_type: errored ? errorType : '',
    evaluator_type: SDK_EVALUATOR_TYPE,
    request_model: row.request_model,
    operation_name: row.operation_name,
    service_name: row.service_name,
    prompt_version: row.prompt_version,
    variant: computeVariant(row.prompt_version, row.request_model),
    content_hash: '',
    span_start_time: row.span_start_time,
    metadata_json: JSON.stringify({ source: 'sdk' }),
  };
}

/**
 * Promote all SDK-recorded evaluation events in the window. Returns the
 * number of rows written (idempotent across overlapping windows, see above).
 */
export async function promoteSdkEvaluations(
  ch: ClickHouseClient,
  since: Date,
  until: Date,
  limit: number,
): Promise<number> {
  const events = await fetchSdkEvaluationEvents(ch, since, until, limit);
  const rows = events.map(toSdkResultRow).filter((row): row is EvalResultRow => row !== undefined);
  await insertEvalResults(ch, rows);
  return rows.length;
}
