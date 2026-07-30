import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { init, shutdown } from '../src/tracer.js';
import { createAISDKTelemetry } from '../src/vercel.js';

const MODEL = 'gpt-4o-2024-08-06';

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
});

afterEach(async () => {
  await shutdown();
});

/** A model scripted to request the tool on step 0, then answer on step 1. */
function scriptedModel(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    modelId: MODEL,
    provider: 'openai',
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'webSearch',
              input: '{"query":"otel genai"}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 120, noncached: 120 },
            outputTokens: { total: 18, reasoning: 0, text: 18 },
          },
          response: { id: 'resp-1', modelId: MODEL },
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: 'AI SDK run complete.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 240, noncached: 240 },
          outputTokens: { total: 12, reasoning: 0, text: 12 },
        },
        response: { id: 'resp-2', modelId: MODEL },
        warnings: [],
      };
    },
  });
}

function webSearchTool() {
  return tool({
    description: 'Search the public web',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => `results for ${query}`,
  });
}

async function runAgent(
  options: { captureContent?: boolean; tag?: { promptVersion?: string; promptName?: string } } = {},
): Promise<ReadableSpan[]> {
  init({
    spanProcessor: new SimpleSpanProcessor(exporter),
    captureContent: options.captureContent,
  });
  const result = await generateText({
    model: scriptedModel(),
    tools: { webSearch: webSearchTool() },
    stopWhen: stepCountIs(3),
    prompt: 'find otel genai news',
    telemetry: {
      functionId: 'researcher',
      integrations: [createAISDKTelemetry({ tag: options.tag })],
    },
  });
  expect(result.text).toBe('AI SDK run complete.');
  return exporter.getFinishedSpans();
}

function byOperation(spans: ReadableSpan[], operation: string): ReadableSpan[] {
  return spans.filter((s) => s.attributes['gen_ai.operation.name'] === operation);
}

describe('createAISDKTelemetry', () => {
  it('captures a generateText tool loop as a conformant agent tree', async () => {
    const spans = await runAgent();

    const roots = spans.filter((s) => !s.parentSpanContext?.spanId);
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.attributes['gen_ai.agent.name']).toBe('researcher');
    expect(root.name).toBe('invoke_agent researcher');
    const traceId = root.spanContext().traceId;
    expect(spans.every((s) => s.spanContext().traceId === traceId)).toBe(true);

    // Two steps, each an execute_task under the operation root.
    const steps = byOperation(spans, 'execute_task');
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }

    const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));

    // Two chat spans, each nested under a step, with model + usage.
    const chats = byOperation(spans, 'chat');
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect(chat.name).toBe(`chat ${MODEL}`);
      expect(chat.attributes['gen_ai.request.model']).toBe(MODEL);
      expect(chat.attributes['gen_ai.provider.name']).toBe('openai');
      const parent = byId.get(chat.parentSpanContext?.spanId ?? '');
      expect(parent?.attributes['gen_ai.operation.name']).toBe('execute_task');
    }
    expect(new Set(chats.map((c) => c.attributes['gen_ai.usage.input_tokens']))).toEqual(
      new Set([120, 240]),
    );

    // The tool call nests under the first step.
    const tools = byOperation(spans, 'execute_tool');
    expect(tools).toHaveLength(1);
    const toolSpan = tools[0]!;
    expect(toolSpan.attributes['gen_ai.tool.name']).toBe('webSearch');
    expect(toolSpan.attributes['gen_ai.tool.call.id']).toBe('call-1');
    expect(toolSpan.name).toBe('execute_tool webSearch');
    const toolParent = byId.get(toolSpan.parentSpanContext?.spanId ?? '');
    expect(toolParent?.attributes['gen_ai.operation.name']).toBe('execute_task');
  });

  it('computes cost from the shared pricing map', async () => {
    const spans = await runAgent();
    const plan = byOperation(spans, 'chat').find(
      (c) => c.attributes['gen_ai.usage.input_tokens'] === 120,
    )!;
    // 120 input + 18 output at gpt-4o pricing (2.5 / 10 per MTok).
    expect(plan.attributes['tracebloom.cost.total_usd']).toBeCloseTo(
      (120 / 1e6) * 2.5 + (18 / 1e6) * 10,
      12,
    );
  });

  it('records no content unless captureContent is set', async () => {
    const spans = await runAgent();
    for (const span of spans) {
      const contentEvents = span.events.filter(
        (e) => e.name.includes('message') || e.name === 'gen_ai.choice',
      );
      expect(contentEvents).toHaveLength(0);
    }
  });

  it('captures content as span events when enabled', async () => {
    const spans = await runAgent({ captureContent: true });
    const finalChat = byOperation(spans, 'chat').find(
      (c) => c.attributes['gen_ai.usage.input_tokens'] === 240,
    )!;
    const names = finalChat.events.map((e) => e.name);
    expect(names).toContain('gen_ai.choice');
    const choice = finalChat.events.find((e) => e.name === 'gen_ai.choice')!;
    expect(String(choice.attributes?.content)).toContain('AI SDK run complete.');

    const toolSpan = byOperation(spans, 'execute_tool')[0]!;
    const toolNames = toolSpan.events.map((e) => e.name);
    expect(toolNames).toContain('gen_ai.tool.message');
    expect(toolNames).toContain('gen_ai.choice');
  });

  it('flows a variant tag through every span', async () => {
    const spans = await runAgent({ tag: { promptVersion: 'v2', promptName: 'research' } });
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.attributes['gen_ai.prompt.version']).toBe('v2');
      expect(span.attributes['gen_ai.prompt.name']).toBe('research');
    }
  });

  it('surfaces the run trace id via onRunStart before the run finishes', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    let started: { traceId: string; spanId: string } | undefined;
    const result = await generateText({
      model: scriptedModel(),
      tools: { webSearch: webSearchTool() },
      stopWhen: stepCountIs(3),
      prompt: 'find otel genai news',
      telemetry: {
        functionId: 'researcher',
        integrations: [
          createAISDKTelemetry({
            onRunStart: (info) => {
              started = info;
            },
          }),
        ],
      },
    });
    expect(result.text).toBe('AI SDK run complete.');
    expect(started?.traceId).toMatch(/^[0-9a-f]{32}$/);
    const root = exporter.getFinishedSpans().find((s) => !s.parentSpanContext?.spanId)!;
    expect(started?.traceId).toBe(root.spanContext().traceId);
  });

  it('is a silent no-op for non-generation operations', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const integration = createAISDKTelemetry();
    // An embedding-style operation id must not open an agent span.
    integration.onStart({ callId: 'embed-1', operationId: 'ai.embed' });
    integration.onEnd({ callId: 'embed-1' });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
