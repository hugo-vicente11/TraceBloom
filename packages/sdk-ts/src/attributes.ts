/**
 * Attribute and event keys from the OpenTelemetry GenAI semantic conventions
 * (the `gen_ai.*` namespace), plus TraceBloom's small set of extension keys.
 *
 * We use the canonical string keys directly rather than importing constants
 * from `@opentelemetry/semantic-conventions/incubating`, because the GenAI
 * conventions are still experimental and the exported constant *names* churn
 * between releases while the wire keys are stable. The keys here ARE the
 * convention.
 */

export const GenAIAttr = {
  OPERATION_NAME: 'gen_ai.operation.name',
  /** Provider id, e.g. `openai`. Renamed from `gen_ai.system` in newer specs. */
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_TOP_P: 'gen_ai.request.top_p',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  /** Name of a named prompt template, e.g. `summarize-v2`. */
  PROMPT_NAME: 'gen_ai.prompt.name',
  /** Version/variant label of the prompt template, e.g. `1.0.0`, `prod`, `v2`. */
  PROMPT_VERSION: 'gen_ai.prompt.version',
  /** Human-readable agent name, e.g. `researcher`. */
  AGENT_NAME: 'gen_ai.agent.name',
  /** Unique agent identifier, when the framework assigns one. */
  AGENT_ID: 'gen_ai.agent.id',
  /** Name of the tool being executed, e.g. `web.search`. */
  TOOL_NAME: 'gen_ai.tool.name',
  /** Tool call id correlating the execution with the model's tool-call request. */
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  /** Tool description as advertised to the model. */
  TOOL_DESCRIPTION: 'gen_ai.tool.description',
} as const;

/** TraceBloom extension attributes (computed cost, retry marking). */
export const TraceBloomAttr = {
  COST_INPUT_USD: 'tracebloom.cost.input_usd',
  COST_OUTPUT_USD: 'tracebloom.cost.output_usd',
  COST_TOTAL_USD: 'tracebloom.cost.total_usd',
  /**
   * 1-based attempt number for an operation that may be retried. Absent or 1
   * means "first try"; >= 2 marks the span as a retry (the trace viewer
   * highlights these). There is no gen_ai.* retry convention yet, hence the
   * tracebloom.* extension key.
   */
  RETRY_ATTEMPT: 'tracebloom.retry.attempt',
} as const;

/** Event name for a model response choice. */
export const EVENT_CHOICE = 'gen_ai.choice';

/** Event name for an input message of the given role (user/system/assistant/tool). */
export function messageEventName(role: string): string {
  return `gen_ai.${role}.message`;
}
