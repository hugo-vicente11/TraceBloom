/**
 * Agent and tool step tracing.
 *
 * Multi-step agents are modeled with the OpenTelemetry GenAI span conventions:
 * an `invoke_agent` span wraps a whole agent run (or a sub-agent delegation),
 * `execute_tool` spans wrap individual tool executions, and any instrumented
 * LLM call made inside them nests automatically via OTel context propagation.
 * The trace viewer reconstructs the tree from exactly this parent/child
 * structure, so wrapping steps with these helpers is all it takes to get a
 * legible agent trace.
 */

import { type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { GenAIAttr, TraceBloomAttr } from './attributes.js';
import { getState } from './tracer.js';

export interface AgentSpanOptions {
  /** Agent name (`gen_ai.agent.name`), e.g. `researcher`. */
  name: string;
  /** Stable agent identifier (`gen_ai.agent.id`), when your framework has one. */
  agentId?: string;
  /** 1-based attempt number; pass >= 2 when re-running a failed step. */
  retryAttempt?: number;
  /** Extra span attributes (must be OTel-compatible primitive values). */
  attributes?: Record<string, string | number | boolean>;
}

export interface ToolSpanOptions {
  /** Tool name (`gen_ai.tool.name`), e.g. `web.search`. */
  name: string;
  /** Tool call id (`gen_ai.tool.call.id`) from the model's tool-call request. */
  callId?: string;
  /** Tool description (`gen_ai.tool.description`) as advertised to the model. */
  description?: string;
  /** 1-based attempt number; pass >= 2 when re-running a failed call. */
  retryAttempt?: number;
  /** Extra span attributes (must be OTel-compatible primitive values). */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Shared wrapper: run `fn` inside an active span so nested LLM/tool/agent
 * spans parent to it, mirror errors onto the span status, and always end it.
 */
async function withGenAISpan<T>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const { tracer } = getState();
  return tracer.startActiveSpan(spanName, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Trace an agent run (or sub-agent delegation) as an `invoke_agent` span.
 * Every traced operation performed inside `fn`: LLM calls, tool executions,
 * nested agents: becomes a child span of it.
 *
 * ```ts
 * await withAgentSpan('researcher', async () => {
 *   const plan = await openai.chat.completions.create({ ... });
 *   await withToolSpan({ name: 'web.search' }, () => search(query));
 * });
 * ```
 */
export function withAgentSpan<T>(
  options: string | AgentSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const opts: AgentSpanOptions = typeof options === 'string' ? { name: options } : options;
  const attributes: Record<string, string | number | boolean> = {
    [GenAIAttr.OPERATION_NAME]: 'invoke_agent',
    [GenAIAttr.AGENT_NAME]: opts.name,
    ...opts.attributes,
  };
  if (opts.agentId) {
    attributes[GenAIAttr.AGENT_ID] = opts.agentId;
  }
  if (typeof opts.retryAttempt === 'number') {
    attributes[TraceBloomAttr.RETRY_ATTEMPT] = opts.retryAttempt;
  }
  return withGenAISpan(`invoke_agent ${opts.name}`, attributes, fn);
}

/**
 * Trace one tool execution as an `execute_tool` span. Throwing from `fn`
 * marks the span as an error and re-throws, so a retry loop around
 * `withToolSpan` yields one span per attempt: pass `retryAttempt` to label
 * the re-tries:
 *
 * ```ts
 * for (let attempt = 1; ; attempt++) {
 *   try {
 *     return await withToolSpan({ name: 'web.search', retryAttempt: attempt }, run);
 *   } catch (error) {
 *     if (attempt >= MAX_ATTEMPTS) throw error;
 *   }
 * }
 * ```
 */
export function withToolSpan<T>(
  options: string | ToolSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const opts: ToolSpanOptions = typeof options === 'string' ? { name: options } : options;
  const attributes: Record<string, string | number | boolean> = {
    [GenAIAttr.OPERATION_NAME]: 'execute_tool',
    [GenAIAttr.TOOL_NAME]: opts.name,
    ...opts.attributes,
  };
  if (opts.callId) {
    attributes[GenAIAttr.TOOL_CALL_ID] = opts.callId;
  }
  if (opts.description) {
    attributes[GenAIAttr.TOOL_DESCRIPTION] = opts.description;
  }
  if (typeof opts.retryAttempt === 'number') {
    attributes[TraceBloomAttr.RETRY_ATTEMPT] = opts.retryAttempt;
  }
  return withGenAISpan(`execute_tool ${opts.name}`, attributes, fn);
}
