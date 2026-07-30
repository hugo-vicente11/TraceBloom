import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAgentSpan, withToolSpan } from '../src/agent.js';
import { wrapChatCompletionCreate } from '../src/openai.js';
import { init, shutdown } from '../src/tracer.js';

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  init({ spanProcessor: new SimpleSpanProcessor(exporter) });
});

afterEach(async () => {
  await shutdown();
});

describe('withAgentSpan', () => {
  it('emits an invoke_agent span and returns the callback result', async () => {
    const result = await withAgentSpan('researcher', async () => 42);
    expect(result).toBe(42);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('invoke_agent researcher');
    expect(span.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(span.attributes['gen_ai.agent.name']).toBe('researcher');
    expect(span.status.code).toBe(1); // OK
  });

  it('parents nested tool and LLM spans to the agent span', async () => {
    const create = wrapChatCompletionCreate(async () => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    await withAgentSpan({ name: 'researcher', agentId: 'agent-7' }, async () => {
      await withToolSpan('web.search', async () => 'results');
      await create({ model: 'gpt-4o', messages: [] });
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    const agent = spans.find((s) => s.name === 'invoke_agent researcher')!;
    const tool = spans.find((s) => s.name === 'execute_tool web.search')!;
    const chat = spans.find((s) => s.name === 'chat gpt-4o')!;
    expect(agent.attributes['gen_ai.agent.id']).toBe('agent-7');
    expect(tool.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(chat.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(tool.spanContext().traceId).toBe(agent.spanContext().traceId);
  });
});

describe('withToolSpan', () => {
  it('records tool attributes and the retry attempt', async () => {
    await withToolSpan(
      { name: 'web.search', callId: 'call-1', description: 'Search the web', retryAttempt: 2 },
      async () => 'ok',
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe('execute_tool web.search');
    expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(span.attributes['gen_ai.tool.name']).toBe('web.search');
    expect(span.attributes['gen_ai.tool.call.id']).toBe('call-1');
    expect(span.attributes['gen_ai.tool.description']).toBe('Search the web');
    expect(span.attributes['tracebloom.retry.attempt']).toBe(2);
  });

  it('marks the span as an error and re-throws when the tool fails', async () => {
    await expect(
      withToolSpan('web.search', async () => {
        throw new Error('rate limited');
      }),
    ).rejects.toThrow('rate limited');

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2); // ERROR
    expect(span.status.message).toBe('rate limited');
    expect(span.events.map((e) => e.name)).toContain('exception');
  });
});
