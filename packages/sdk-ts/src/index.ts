/**
 * TraceBloom TypeScript SDK.
 *
 * Quickstart:
 * ```ts
 * import { init, instrumentOpenAI } from '@tracebloom/sdk';
 * init({ endpoint: 'http://localhost:4318', serviceName: 'my-app' });
 * const openai = instrumentOpenAI(new OpenAI());
 * // every chat.completions.create call now emits a gen_ai span
 * ```
 */

export {
  type AgentSpanOptions,
  type ToolSpanOptions,
  withAgentSpan,
  withToolSpan,
} from './agent.js';
export { GenAIAttr, TraceBloomAttr } from './attributes.js';
export {
  EVALUATION_RESULT_EVENT,
  EvaluationAttr,
  type EvaluationRecord,
  recordEvaluation,
} from './evals.js';
export {
  type ChatCompletionCreate,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  instrumentOpenAI,
  type OpenAILike,
  wrapChatCompletionCreate,
} from './openai.js';
export {
  type CostBreakdown,
  computeCost,
  DEFAULT_PRICING,
  lookupPrice,
  type ModelPrice,
  type PricingMap,
} from './pricing.js';
export { type PromptTag, setPromptVersion } from './prompt.js';
export { init, shutdown, type TraceBloomConfig } from './tracer.js';
export {
  type AISDKRunInfo,
  type AISDKTelemetry,
  type AISDKTelemetryOptions,
  createAISDKTelemetry,
} from './vercel.js';
