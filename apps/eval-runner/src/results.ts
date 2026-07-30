/**
 * Assembles the ClickHouse `eval_results` row from an evaluator outcome and the
 * evaluated span. This is where the OTel `gen_ai.evaluation.result` attributes
 * are materialized into typed columns (see `@tracebloom/eval`'s
 * `toEvaluationResultEvent` for the canonical event shape).
 */

import type { EvalOutcome, EvalType, EvaluatedSpan } from '@tracebloom/eval';
import type { CachedResult, EvalResultRow } from './clickhouse.js';

export interface RowParams {
  evalId: string;
  evalVersion: number;
  evaluatorType: EvalType;
  evaluationName: string;
  span: EvaluatedSpan;
  variant: string;
  contentHash: string;
}

export function buildResultRow(params: RowParams, outcome: EvalOutcome): EvalResultRow {
  const { span } = params;
  const errored = Boolean(outcome.errorType);
  return {
    eval_id: params.evalId,
    eval_version: params.evalVersion,
    trace_id: span.traceId,
    span_id: span.spanId,
    response_id: span.responseId,
    evaluation_name: params.evaluationName,
    // On error the score is not applicable; store 0 and exclude via error_type in queries.
    score_value: errored ? 0 : outcome.score,
    score_label: outcome.label ?? '',
    passed: outcome.passed ? 1 : 0,
    explanation: outcome.reason ?? '',
    error_type: outcome.errorType ?? '',
    evaluator_type: params.evaluatorType,
    request_model: span.requestModel,
    operation_name: span.operationName,
    service_name: span.serviceName,
    prompt_version: span.promptVersion,
    variant: params.variant,
    content_hash: params.contentHash,
    span_start_time: span.spanStartTime,
    metadata_json: JSON.stringify(outcome.metadata ?? {}),
  };
}

/** Build a row from a cache hit, reusing a prior successful score (no re-scoring). */
export function buildRowFromCache(params: RowParams, cached: CachedResult): EvalResultRow {
  const { span } = params;
  return {
    eval_id: params.evalId,
    eval_version: params.evalVersion,
    trace_id: span.traceId,
    span_id: span.spanId,
    response_id: span.responseId,
    evaluation_name: params.evaluationName,
    score_value: cached.score_value,
    score_label: cached.score_label,
    passed: cached.passed,
    explanation: cached.explanation,
    error_type: '',
    evaluator_type: params.evaluatorType,
    request_model: span.requestModel,
    operation_name: span.operationName,
    service_name: span.serviceName,
    prompt_version: span.promptVersion,
    variant: params.variant,
    content_hash: params.contentHash,
    span_start_time: span.spanStartTime,
    metadata_json: JSON.stringify({ cached: true }),
  };
}
