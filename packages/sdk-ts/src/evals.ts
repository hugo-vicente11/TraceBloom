/**
 * Eval hooks: attach feedback/scores to spans from application code.
 *
 * `recordEvaluation` emits the canonical OpenTelemetry
 * `gen_ai.evaluation.result` event (the same shape the evaluation engine
 * stores: see DECISIONS.md D8) onto the active span. The collector persists
 * it in `span_events`, and the eval runner promotes it into `eval_results`
 * out-of-band, so SDK-recorded scores (human feedback, in-app heuristics,
 * guardrail verdicts) show up in the Evals view and the trace viewer exactly
 * like engine-computed ones.
 */

import { type Span, trace } from '@opentelemetry/api';

/** The canonical OTel event name for an evaluation result. */
export const EVALUATION_RESULT_EVENT = 'gen_ai.evaluation.result';

/** OTel `gen_ai.evaluation.*` (and related) attribute keys. */
export const EvaluationAttr = {
  NAME: 'gen_ai.evaluation.name',
  SCORE_VALUE: 'gen_ai.evaluation.score.value',
  SCORE_LABEL: 'gen_ai.evaluation.score.label',
  EXPLANATION: 'gen_ai.evaluation.explanation',
  ERROR_TYPE: 'error.type',
} as const;

/** A score (or evaluation failure) to attach to a span. */
export interface EvaluationRecord {
  /** Normalized score in [0, 1]. Required unless `errorType` is set. */
  score?: number;
  /** Human-readable label, e.g. `pass` / `fail` / `thumbs_up`. */
  label?: string;
  /** Free-form rationale for the score. */
  reason?: string;
  /** Set instead of `score` when the evaluation itself failed. */
  errorType?: string;
}

/**
 * Record an evaluation result on the active span (or an explicitly provided
 * one):
 *
 * ```ts
 * await withAgentSpan('researcher', async (span) => {
 *   const answer = await runAgent();
 *   recordEvaluation('user_feedback', { score: 1, label: 'thumbs_up' });
 * });
 * ```
 *
 * No-op when there is no active/recording span (like `setPromptVersion`), so
 * it is always safe to call. Throws a `TypeError` when neither `score` nor
 * `errorType` is given: that is a programming error, not a runtime condition.
 */
export function recordEvaluation(name: string, record: EvaluationRecord, span?: Span): void {
  if (record.score === undefined && !record.errorType) {
    throw new TypeError('recordEvaluation: either score or errorType is required');
  }
  const target = span ?? trace.getActiveSpan();
  if (!target || !target.isRecording()) {
    return;
  }
  const attributes: Record<string, string | number> = { [EvaluationAttr.NAME]: name };
  if (record.errorType) {
    attributes[EvaluationAttr.ERROR_TYPE] = record.errorType;
  } else if (record.score !== undefined) {
    attributes[EvaluationAttr.SCORE_VALUE] = record.score;
    if (record.label) {
      attributes[EvaluationAttr.SCORE_LABEL] = record.label;
    }
  }
  if (record.reason) {
    attributes[EvaluationAttr.EXPLANATION] = record.reason;
  }
  target.addEvent(EVALUATION_RESULT_EVENT, attributes);
}
