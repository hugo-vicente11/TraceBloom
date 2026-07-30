/**
 * OpenAI-shaped chat-completions instrumentation.
 *
 * We deliberately depend on a minimal *structural* type rather than the
 * `openai` package, so the SDK stays light and provider-agnostic: anything that
 * exposes `chat.completions.create(params) => Promise<response>` with the usual
 * fields can be wrapped, including the mock client used in tests.
 */

import { type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { EVENT_CHOICE, GenAIAttr, messageEventName, TraceBloomAttr } from './attributes.js';
import { computeCost } from './pricing.js';
import type { PromptTag } from './prompt.js';
import { getState } from './tracer.js';

export interface ChatMessage {
  role: string;
  content?: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChoice {
  finish_reason?: string | null;
  message?: { role?: string; content?: string | null };
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  [key: string]: unknown;
}

export type ChatCompletionCreate = (
  params: ChatCompletionRequest,
  ...rest: unknown[]
) => Promise<ChatCompletionResponse>;

export interface OpenAILike {
  chat: { completions: { create: ChatCompletionCreate } };
}

const PROVIDER = 'openai';

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined || content === null) {
    return '';
  }
  return JSON.stringify(content);
}

function recordRequest(
  span: Span,
  params: ChatCompletionRequest,
  captureContent: boolean,
  tag?: PromptTag,
): void {
  span.setAttribute(GenAIAttr.OPERATION_NAME, 'chat');
  span.setAttribute(GenAIAttr.PROVIDER_NAME, PROVIDER);
  span.setAttribute(GenAIAttr.REQUEST_MODEL, params.model);
  if (tag?.promptVersion) {
    span.setAttribute(GenAIAttr.PROMPT_VERSION, tag.promptVersion);
  }
  if (tag?.promptName) {
    span.setAttribute(GenAIAttr.PROMPT_NAME, tag.promptName);
  }
  if (typeof params.temperature === 'number') {
    span.setAttribute(GenAIAttr.REQUEST_TEMPERATURE, params.temperature);
  }
  if (typeof params.top_p === 'number') {
    span.setAttribute(GenAIAttr.REQUEST_TOP_P, params.top_p);
  }
  if (typeof params.max_tokens === 'number') {
    span.setAttribute(GenAIAttr.REQUEST_MAX_TOKENS, params.max_tokens);
  }
  if (captureContent) {
    for (const message of params.messages ?? []) {
      const role = typeof message.role === 'string' ? message.role : 'user';
      span.addEvent(messageEventName(role), { content: stringifyContent(message.content) });
    }
  }
}

function recordResponse(
  span: Span,
  params: ChatCompletionRequest,
  response: ChatCompletionResponse,
  captureContent: boolean,
): void {
  const responseModel = response.model ?? params.model;
  span.setAttribute(GenAIAttr.RESPONSE_MODEL, responseModel);
  if (response.id) {
    span.setAttribute(GenAIAttr.RESPONSE_ID, response.id);
  }

  const finishReasons = (response.choices ?? [])
    .map((choice) => choice.finish_reason)
    .filter((reason): reason is string => typeof reason === 'string');
  if (finishReasons.length > 0) {
    span.setAttribute(GenAIAttr.RESPONSE_FINISH_REASONS, finishReasons);
  }

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  span.setAttribute(GenAIAttr.USAGE_INPUT_TOKENS, inputTokens);
  span.setAttribute(GenAIAttr.USAGE_OUTPUT_TOKENS, outputTokens);

  const cost = computeCost(responseModel, inputTokens, outputTokens, getState().pricing);
  span.setAttribute(TraceBloomAttr.COST_INPUT_USD, cost.inputUsd);
  span.setAttribute(TraceBloomAttr.COST_OUTPUT_USD, cost.outputUsd);
  span.setAttribute(TraceBloomAttr.COST_TOTAL_USD, cost.totalUsd);

  if (captureContent) {
    (response.choices ?? []).forEach((choice, index) => {
      span.addEvent(EVENT_CHOICE, {
        index,
        finish_reason: choice.finish_reason ?? '',
        content: stringifyContent(choice.message?.content),
      });
    });
  }
}

/**
 * Wrap a chat-completions `create` function so each call emits a gen_ai CLIENT
 * span. The wrapper is transparent: it returns the provider's response
 * unchanged and re-throws provider errors after recording them.
 */
export function wrapChatCompletionCreate(
  create: ChatCompletionCreate,
  tag?: PromptTag,
): ChatCompletionCreate {
  return function tracedCreate(params, ...rest) {
    const { tracer, captureContent } = getState();
    return tracer.startActiveSpan(
      `chat ${params.model}`,
      { kind: SpanKind.CLIENT },
      async (span) => {
        recordRequest(span, params, captureContent, tag);
        try {
          const response = await create(params, ...rest);
          recordResponse(span, params, response, captureContent);
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
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
      },
    );
  };
}

/**
 * Auto-instrument an OpenAI-shaped client in place: replaces
 * `client.chat.completions.create` with a traced version and returns the same
 * client for convenience.
 *
 * Pass `{ promptVersion }` to tag every span from this client with a variant
 * label (used by the evaluation engine's variant comparison):
 *
 * ```ts
 * import OpenAI from 'openai';
 * import { init, instrumentOpenAI } from '@tracebloom/sdk';
 * init();
 * const client = instrumentOpenAI(new OpenAI(), { promptVersion: 'v2' });
 * await client.chat.completions.create({ model: 'gpt-4o', messages: [...] });
 * ```
 */
export function instrumentOpenAI<T extends OpenAILike>(client: T, tag?: PromptTag): T {
  const completions = client.chat.completions;
  const original = completions.create.bind(completions);
  completions.create = wrapChatCompletionCreate(
    original,
    tag,
  ) as T['chat']['completions']['create'];
  return client;
}
