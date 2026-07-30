/**
 * TraceBloom evaluation framework.
 *
 * Two built-in evaluators: a config-driven deterministic one and an
 * LLM-as-judge: implement a common `Evaluator` interface and produce outcomes
 * that map onto the OpenTelemetry `gen_ai.evaluation.result` event.
 */

export {
  ConfigError,
  validateConfig,
  validateDeterministicConfig,
  validateJudgeConfig,
} from './config.js';
export {
  type DeterministicConfig,
  DeterministicEvaluator,
  type DeterministicRule,
  type DeterministicTarget,
} from './deterministic.js';
export {
  type JudgeClient,
  type JudgeConfig,
  JudgeEvaluator,
  type JudgeVerdict,
  parseJudgeResponse,
} from './judge.js';
export {
  contentHash,
  EVALUATION_RESULT_EVENT,
  EvaluationAttr,
  type EvaluationResultEvent,
  toEvaluationResultEvent,
} from './result.js';
export type {
  EvalInput,
  EvalOutcome,
  EvalType,
  EvaluatedSpan,
  Evaluator,
} from './types.js';
