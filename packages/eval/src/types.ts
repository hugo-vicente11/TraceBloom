/**
 * Core evaluation types shared by the evaluators, the runner, and the dashboard.
 *
 * An `Evaluator` is a pure function of `(input, config) -> outcome`; it performs
 * no storage I/O. The LLM-as-judge evaluator does make a model call, but through
 * an *injected* client (see `JudgeClient`), so it stays testable without a real
 * API key and lets the runner wrap that client with the TraceBloom SDK to
 * dogfood-instrument the judge's own calls.
 */

/** Evaluator kind. Mirrors `eval_definitions.type` in Postgres. */
export type EvalType = 'deterministic' | 'llm_judge';

/**
 * The subset of an evaluated span the evaluators and runner care about, already
 * decoded from ClickHouse. `attributes` is the lossless overflow JSON parsed to
 * an object (where `gen_ai.prompt.version` etc. live).
 */
export interface EvaluatedSpan {
  traceId: string;
  spanId: string;
  /** gen_ai.response.id — links the result to the completion when span id is unavailable. */
  responseId: string;
  requestModel: string;
  operationName: string;
  serviceName: string;
  /** gen_ai.prompt.version, or '' if the span was not tagged. */
  promptVersion: string;
  /** The span's start time as an ISO-8601 string (the eval result's time axis). */
  spanStartTime: string;
  attributes: Record<string, unknown>;
}

/** What an evaluator receives: the reconstructed input/output text plus the span. */
export interface EvalInput {
  /** Concatenated user/system message content (the prompt). May be empty. */
  input: string;
  /** Concatenated model output/choice content. May be empty. */
  output: string;
  span: EvaluatedSpan;
}

/**
 * The result of a single evaluation. Maps directly onto the OTel
 * `gen_ai.evaluation.result` event attributes (see `toEvaluationResultEvent`):
 * `score` -> gen_ai.evaluation.score.value, `label` -> score.label,
 * `reason` -> explanation, `errorType` -> error.type. `passed` is a TraceBloom
 * convenience derived by the evaluator.
 */
export interface EvalOutcome {
  /** Normalized score in [0, 1]. 0 when the evaluation errored. */
  score: number;
  passed: boolean;
  /** Human-readable label, e.g. `pass` / `fail` / `relevant`. */
  label?: string;
  /** Free-form rationale (judge explanation, or which rules failed). */
  reason?: string;
  /** Evaluator-specific extra data, persisted losslessly as JSON. */
  metadata?: Record<string, unknown>;
  /**
   * Set only when the evaluation itself failed (e.g. judge timeout). A non-empty
   * value maps to OTel `error.type`; such rows are excluded from score
   * aggregations. The evaluator MUST NOT throw: it returns this instead.
   */
  errorType?: string;
}

/**
 * A pluggable evaluator. Implementations are constructed with any dependencies
 * they need (e.g. the judge client) and expose a single `evaluate` method.
 */
export interface Evaluator<C = unknown> {
  readonly type: EvalType;
  /** Stable metric name recorded as `gen_ai.evaluation.name`. */
  readonly name: string;
  evaluate(input: EvalInput, config: C): Promise<EvalOutcome>;
}
