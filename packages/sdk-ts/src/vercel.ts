/**
 * Vercel AI SDK (`ai`) integration.
 *
 * The AI SDK exposes a first-class telemetry hook: `registerTelemetry()` (and
 * the per-call `telemetry.integrations` option): that delivers lifecycle
 * events for every `generateText` / `streamText` run: operation start/end,
 * per-step start/end, each language-model call, and each tool execution, plus
 * `executeLanguageModelCall` / `executeTool` wrappers that let an integration
 * run those phases inside its own span context. We build gen_ai spans off that
 * native hook rather than the AI SDK's built-in OTel span emission, so content
 * obeys the TraceBloom D2 rule (events, off by default), cost comes from the
 * shared pricing map, and the tree matches every other integration:
 *
 *   invoke_agent (the run, named by `functionId`)
 *     └─ execute_task (step N)
 *          ├─ chat        (the language-model call: model, usage, cost)
 *          └─ execute_tool (each tool the step invoked)
 *
 * The `execute*` wrappers set the step/tool span as the active OTel context
 * while that phase runs, so a tool whose `execute` calls `generateText` again
 * (an agent-as-tool / sub-agent) nests correctly underneath it.
 *
 * Like `openai.ts`, this depends only on a minimal *structural* type of the AI
 * SDK's telemetry surface: never the `ai` package, so the SDK stays light and
 * the integration is a silent no-op unless the app wires it in.
 */

import {
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { EVENT_CHOICE, GenAIAttr, messageEventName, TraceBloomAttr } from './attributes.js';
import { computeCost } from './pricing.js';
import type { PromptTag } from './prompt.js';
import { getState } from './tracer.js';

/** Token usage as the AI SDK reports it on model-call / step / operation events. */
export interface AISDKUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** A message as it appears in AI SDK prompt/step events (role + string or parts). */
export interface AISDKMessage {
  role?: string;
  content?: unknown;
}

/** The tool-call descriptor carried on tool-execution events. */
export interface AISDKToolCall {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

/** Discriminated tool result carried on `onToolExecutionEnd`. */
export interface AISDKToolOutput {
  type?: string;
  output?: unknown;
  error?: unknown;
}

export interface AISDKOperationStartEvent {
  callId: string;
  operationId?: string;
  provider?: string;
  modelId?: string;
  functionId?: string;
}

export interface AISDKStepEvent {
  callId: string;
  stepNumber?: number;
}

export interface AISDKModelCallStartEvent {
  callId: string;
  provider?: string;
  modelId?: string;
  // Typed loosely so this integration stays assignable to the AI SDK's own
  // event types (whose message/instruction shapes are richer); narrowed and
  // stringified defensively where read.
  messages?: readonly AISDKMessage[];
  instructions?: unknown;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface AISDKModelCallEndEvent {
  callId: string;
  provider?: string;
  modelId?: string;
  finishReason?: string;
  usage?: AISDKUsage;
  responseId?: string;
  content?: unknown;
}

export interface AISDKToolStartEvent {
  callId: string;
  toolCall?: AISDKToolCall;
}

export interface AISDKToolEndEvent {
  callId: string;
  toolCall?: AISDKToolCall;
  toolOutput?: AISDKToolOutput;
}

export interface AISDKExecuteModelOptions {
  callId: string;
}

export interface AISDKExecuteToolOptions {
  callId: string;
  toolCallId: string;
}

/**
 * The subset of the AI SDK `Telemetry` interface this integration implements.
 * All members are optional there, so this object is a valid integration to
 * pass to `registerTelemetry(...)` or `telemetry.integrations`.
 */
export interface AISDKTelemetry {
  onStart(event: AISDKOperationStartEvent): void;
  onStepStart(event: AISDKStepEvent): void;
  onLanguageModelCallStart(event: AISDKModelCallStartEvent): void;
  onLanguageModelCallEnd(event: AISDKModelCallEndEvent): void;
  onToolExecutionStart(event: AISDKToolStartEvent): void;
  onToolExecutionEnd(event: AISDKToolEndEvent): void;
  onStepEnd(event: AISDKStepEvent): void;
  onEnd(event: { callId: string }): void;
  executeLanguageModelCall<T>(
    options: AISDKExecuteModelOptions & { execute: () => PromiseLike<T> },
  ): PromiseLike<T>;
  executeTool<T>(
    options: AISDKExecuteToolOptions & { execute: () => PromiseLike<T> },
  ): PromiseLike<T>;
}

/** Identifiers for a run's root span, surfaced as soon as the run starts. */
export interface AISDKRunInfo {
  traceId: string;
  spanId: string;
}

export interface AISDKTelemetryOptions {
  /** Tag every span from this integration with a variant label (see PromptTag). */
  tag?: PromptTag;
  /**
   * Called when a run's root (`invoke_agent`) span is created, before the run
   * finishes: lets a host correlate the trace id early (e.g. to stream it to
   * a client while the agent is still running).
   */
  onRunStart?: (info: AISDKRunInfo) => void;
}

/** The operations whose lifecycle we model as an agent run. */
const GENERATION_OPERATIONS = new Set([
  'ai.generateText',
  'ai.streamText',
  'ai.generateObject',
  'ai.streamObject',
]);

interface StepEntry {
  span: Span;
  ctx: Context;
}

interface OperationState {
  operationCtx: Context;
  steps: Map<number, StepEntry>;
  currentStepCtx?: Context;
  /** Model-call spans awaiting their end event (sequential; a stack for safety). */
  modelStack: { span: Span; ctx: Context }[];
  toolSpans: Map<string, Span>;
  span: Span;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined || content === null) {
    return '';
  }
  if (Array.isArray(content)) {
    // Message parts / content parts: join the text-bearing ones.
    const texts = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((text) => text.length > 0);
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return JSON.stringify(content);
}

function operationName(event: AISDKOperationStartEvent): string {
  if (event.functionId) {
    return event.functionId;
  }
  const id = event.operationId ?? 'ai.generateText';
  return id.replace(/^ai\./, '');
}

/**
 * Create an AI SDK telemetry integration that emits TraceBloom gen_ai spans.
 * Register it once globally, or pass it per call:
 *
 * ```ts
 * import { registerTelemetry, generateText } from 'ai';
 * import { init, createAISDKTelemetry } from '@tracebloom/sdk';
 * init();
 * registerTelemetry(createAISDKTelemetry({ tag: { promptVersion: 'v2' } }));
 * await generateText({ model, prompt, telemetry: { functionId: 'researcher' } });
 * ```
 */
export function createAISDKTelemetry(options: AISDKTelemetryOptions = {}): AISDKTelemetry {
  const tag = options.tag;
  // Keyed by callId (one AI SDK operation). Concurrent operations are isolated.
  const ops = new Map<string, OperationState>();

  function applyTag(span: Span): void {
    if (tag?.promptVersion) {
      span.setAttribute(GenAIAttr.PROMPT_VERSION, tag.promptVersion);
    }
    if (tag?.promptName) {
      span.setAttribute(GenAIAttr.PROMPT_NAME, tag.promptName);
    }
  }

  function parentCtxFor(state: OperationState): Context {
    return state.currentStepCtx ?? state.operationCtx;
  }

  return {
    onStart(event) {
      if (event.operationId && !GENERATION_OPERATIONS.has(event.operationId)) {
        return; // embeddings / reranking: not an agent run.
      }
      const { tracer } = getState();
      const parent = context.active();
      const name = operationName(event);
      const span = tracer.startSpan(
        `invoke_agent ${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: { [GenAIAttr.OPERATION_NAME]: 'invoke_agent', [GenAIAttr.AGENT_NAME]: name },
        },
        parent,
      );
      applyTag(span);
      ops.set(event.callId, {
        span,
        operationCtx: trace.setSpan(parent, span),
        steps: new Map(),
        modelStack: [],
        toolSpans: new Map(),
      });
      if (options.onRunStart) {
        const ctx = span.spanContext();
        options.onRunStart({ traceId: ctx.traceId, spanId: ctx.spanId });
      }
    },

    onStepStart(event) {
      const state = ops.get(event.callId);
      if (!state || typeof event.stepNumber !== 'number') {
        return;
      }
      const { tracer } = getState();
      const label = `step ${event.stepNumber}`;
      const span = tracer.startSpan(
        `execute_task ${label}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: { [GenAIAttr.OPERATION_NAME]: 'execute_task', 'gen_ai.task.name': label },
        },
        state.operationCtx,
      );
      applyTag(span);
      const ctx = trace.setSpan(state.operationCtx, span);
      state.steps.set(event.stepNumber, { span, ctx });
      state.currentStepCtx = ctx;
    },

    onLanguageModelCallStart(event) {
      const state = ops.get(event.callId);
      if (!state) {
        return;
      }
      const { tracer, captureContent } = getState();
      const parent = parentCtxFor(state);
      const model = event.modelId ?? '';
      const span = tracer.startSpan(
        model ? `chat ${model}` : 'chat',
        { kind: SpanKind.CLIENT, attributes: { [GenAIAttr.OPERATION_NAME]: 'chat' } },
        parent,
      );
      if (event.provider) {
        span.setAttribute(GenAIAttr.PROVIDER_NAME, event.provider);
      }
      if (model) {
        span.setAttribute(GenAIAttr.REQUEST_MODEL, model);
      }
      if (typeof event.temperature === 'number') {
        span.setAttribute(GenAIAttr.REQUEST_TEMPERATURE, event.temperature);
      }
      if (typeof event.topP === 'number') {
        span.setAttribute(GenAIAttr.REQUEST_TOP_P, event.topP);
      }
      if (typeof event.maxOutputTokens === 'number') {
        span.setAttribute(GenAIAttr.REQUEST_MAX_TOKENS, event.maxOutputTokens);
      }
      applyTag(span);
      if (captureContent) {
        if (event.instructions !== undefined && event.instructions !== null) {
          span.addEvent(messageEventName('system'), {
            content: stringifyContent(event.instructions),
          });
        }
        for (const message of event.messages ?? []) {
          const role = typeof message.role === 'string' ? message.role : 'user';
          span.addEvent(messageEventName(role), { content: stringifyContent(message.content) });
        }
      }
      state.modelStack.push({ span, ctx: trace.setSpan(parent, span) });
    },

    onLanguageModelCallEnd(event) {
      const state = ops.get(event.callId);
      const entry = state?.modelStack.pop();
      if (!entry) {
        return;
      }
      const { captureContent, pricing } = getState();
      const span = entry.span;
      const model = event.modelId ?? '';
      if (model) {
        span.setAttribute(GenAIAttr.RESPONSE_MODEL, model);
      }
      if (event.responseId) {
        span.setAttribute(GenAIAttr.RESPONSE_ID, event.responseId);
      }
      if (event.finishReason) {
        span.setAttribute(GenAIAttr.RESPONSE_FINISH_REASONS, [event.finishReason]);
      }
      const inputTokens = event.usage?.inputTokens ?? 0;
      const outputTokens = event.usage?.outputTokens ?? 0;
      span.setAttribute(GenAIAttr.USAGE_INPUT_TOKENS, inputTokens);
      span.setAttribute(GenAIAttr.USAGE_OUTPUT_TOKENS, outputTokens);
      if (model) {
        const cost = computeCost(model, inputTokens, outputTokens, pricing);
        span.setAttribute(TraceBloomAttr.COST_INPUT_USD, cost.inputUsd);
        span.setAttribute(TraceBloomAttr.COST_OUTPUT_USD, cost.outputUsd);
        span.setAttribute(TraceBloomAttr.COST_TOTAL_USD, cost.totalUsd);
      }
      if (captureContent && event.content !== undefined && event.content !== null) {
        span.addEvent(EVENT_CHOICE, {
          index: 0,
          finish_reason: event.finishReason ?? '',
          content: stringifyContent(event.content),
        });
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },

    onToolExecutionStart(event) {
      const state = ops.get(event.callId);
      const toolCallId = event.toolCall?.toolCallId;
      if (!state || !toolCallId) {
        return;
      }
      const { tracer, captureContent } = getState();
      const toolName = event.toolCall?.toolName ?? 'tool';
      const span = tracer.startSpan(
        `execute_tool ${toolName}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            [GenAIAttr.OPERATION_NAME]: 'execute_tool',
            [GenAIAttr.TOOL_NAME]: toolName,
            [GenAIAttr.TOOL_CALL_ID]: toolCallId,
          },
        },
        parentCtxFor(state),
      );
      applyTag(span);
      if (captureContent && event.toolCall?.input !== undefined) {
        span.addEvent(messageEventName('tool'), {
          content: stringifyContent(event.toolCall.input),
        });
      }
      state.toolSpans.set(toolCallId, span);
    },

    onToolExecutionEnd(event) {
      const state = ops.get(event.callId);
      const toolCallId = event.toolCall?.toolCallId;
      const span = toolCallId ? state?.toolSpans.get(toolCallId) : undefined;
      if (!state || !span || !toolCallId) {
        return;
      }
      const { captureContent } = getState();
      const output = event.toolOutput;
      if (output?.type === 'tool-error' || output?.error !== undefined) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: stringifyContent(output?.error) });
      } else {
        if (captureContent && output?.output !== undefined) {
          span.addEvent(EVENT_CHOICE, {
            index: 0,
            finish_reason: '',
            content: stringifyContent(output.output),
          });
        }
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
      state.toolSpans.delete(toolCallId);
    },

    onStepEnd(event) {
      const state = ops.get(event.callId);
      if (!state || typeof event.stepNumber !== 'number') {
        return;
      }
      const entry = state.steps.get(event.stepNumber);
      if (!entry) {
        return;
      }
      entry.span.setStatus({ code: SpanStatusCode.OK });
      entry.span.end();
      state.steps.delete(event.stepNumber);
      if (state.currentStepCtx === entry.ctx) {
        state.currentStepCtx = undefined;
      }
    },

    onEnd(event) {
      const state = ops.get(event.callId);
      if (!state) {
        return;
      }
      // Close anything the SDK didn't bracket (defensive: errors mid-run).
      for (const { span } of state.modelStack) {
        span.end();
      }
      for (const span of state.toolSpans.values()) {
        span.end();
      }
      for (const { span } of state.steps.values()) {
        span.end();
      }
      state.span.setStatus({ code: SpanStatusCode.OK });
      state.span.end();
      ops.delete(event.callId);
    },

    executeLanguageModelCall<T>(
      options: AISDKExecuteModelOptions & { execute: () => PromiseLike<T> },
    ): PromiseLike<T> {
      const state = ops.get(options.callId);
      const ctx = state?.modelStack.at(-1)?.ctx;
      if (!ctx) {
        return options.execute();
      }
      // context.with runs execute() (which returns PromiseLike<T>) within ctx;
      // the OTel signature widens the result, so re-narrow it.
      return context.with(ctx, options.execute) as PromiseLike<T>;
    },

    executeTool<T>(
      options: AISDKExecuteToolOptions & { execute: () => PromiseLike<T> },
    ): PromiseLike<T> {
      const state = ops.get(options.callId);
      const span = state?.toolSpans.get(options.toolCallId);
      if (!state || !span) {
        return options.execute();
      }
      return context.with(
        trace.setSpan(parentCtxFor(state), span),
        options.execute,
      ) as PromiseLike<T>;
    },
  };
}
