/**
 * Builds the judge model client. It is a plain OpenAI-compatible client wrapped
 * with the TraceBloom SDK's `instrumentOpenAI`, so every judge call the runner
 * makes emits a `gen_ai` span to the collector: the tool dogfoods its own
 * instrumentation (decision #2). Returns `undefined` when no API key is set, in
 * which case the runner skips `llm_judge` evals rather than failing.
 */

import type { JudgeClient } from '@tracebloom/eval';
import { instrumentOpenAI, type OpenAILike } from '@tracebloom/sdk';
import OpenAI from 'openai';
import type { RunnerConfig } from './env.js';

/** Service name for the runner's own judge spans; excluded from evaluation. */
export const JUDGE_SERVICE_NAME = 'tracebloom-eval-runner';

export function createJudgeClient(config: RunnerConfig): JudgeClient | undefined {
  if (!config.judgeApiKey) {
    return undefined;
  }
  const client = new OpenAI({ apiKey: config.judgeApiKey, baseURL: config.judgeBaseUrl });
  // The OpenAI client is structurally an OpenAILike (chat.completions.create);
  // the SDK wrapper replaces `create` with an instrumented version in place.
  return instrumentOpenAI(client as unknown as OpenAILike, { promptName: 'tracebloom-judge' });
}
