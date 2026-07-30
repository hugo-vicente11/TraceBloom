/**
 * Constructs a validated evaluator from a stored eval definition. Config
 * validation happens here so a malformed definition throws before any span is
 * scored; the runner catches that per-eval and moves on.
 */

import type { EvalDefinition } from '@tracebloom/db';
import {
  type DeterministicConfig,
  DeterministicEvaluator,
  type Evaluator,
  type JudgeClient,
  type JudgeConfig,
  JudgeEvaluator,
  validateConfig,
} from '@tracebloom/eval';

export interface BuiltEvaluator {
  evaluator: Evaluator;
  config: DeterministicConfig | JudgeConfig;
  /** Recorded as `gen_ai.evaluation.name`. */
  evaluationName: string;
}

export function buildEvaluator(def: EvalDefinition, judgeClient?: JudgeClient): BuiltEvaluator {
  const config = validateConfig(def.type, def.config);
  if (def.type === 'deterministic') {
    return { evaluator: new DeterministicEvaluator(def.name), config, evaluationName: def.name };
  }
  if (!judgeClient) {
    throw new Error(
      `eval "${def.name}" is llm_judge but no judge client is configured (set OPENAI_API_KEY)`,
    );
  }
  const judgeConfig = config as JudgeConfig;
  const evaluationName = judgeConfig.metricName ?? def.name;
  return {
    evaluator: new JudgeEvaluator(judgeClient, evaluationName),
    config: judgeConfig,
    evaluationName,
  };
}
