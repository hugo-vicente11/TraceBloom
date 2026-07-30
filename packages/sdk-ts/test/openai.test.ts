import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatCompletionResponse,
  instrumentOpenAI,
  wrapChatCompletionCreate,
} from '../src/openai.js';
import { init, shutdown } from '../src/tracer.js';

// A fresh exporter per test: shutdown() (called in afterEach) tears down the
// span processor and its exporter, so a shared instance would be stopped for
// subsequent tests.
let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
});

afterEach(async () => {
  await shutdown();
});

function fakeResponse(): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    model: 'gpt-4o-2024-08-06',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi there' } }],
    usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
  };
}

describe('instrumentOpenAI', () => {
  it('emits a gen_ai span with model, tokens and cost', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const client = instrumentOpenAI({
      chat: { completions: { create: async () => fakeResponse() } },
    });

    const res = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.id).toBe('chatcmpl-test');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('chat gpt-4o');
    expect(span.kind).toBe(2); // CLIENT
    expect(span.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(span.attributes['gen_ai.provider.name']).toBe('openai');
    expect(span.attributes['gen_ai.response.model']).toBe('gpt-4o-2024-08-06');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(60);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(40);
    expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    // 60 input + 40 output tokens at gpt-4o pricing (2.5 / 10 per MTok).
    expect(span.attributes['tracebloom.cost.total_usd']).toBeCloseTo(
      (60 / 1e6) * 2.5 + (40 / 1e6) * 10,
      12,
    );
    expect(span.status.code).toBe(1); // OK
  });

  it('does not record content unless captureContent is set', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const create = wrapChatCompletionCreate(async () => fakeResponse());
    await create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'secret' }] });
    expect(exporter.getFinishedSpans()[0]!.events).toHaveLength(0);
  });

  it('captures content as span events when enabled', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter), captureContent: true });
    const create = wrapChatCompletionCreate(async () => fakeResponse());
    await create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] });
    const names = exporter.getFinishedSpans()[0]!.events.map((event) => event.name);
    expect(names).toContain('gen_ai.user.message');
    expect(names).toContain('gen_ai.choice');
  });

  it('records errors and re-throws', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const create = wrapChatCompletionCreate(async () => {
      throw new Error('boom');
    });
    await expect(create({ model: 'gpt-4o', messages: [] })).rejects.toThrow('boom');
    expect(exporter.getFinishedSpans()[0]!.status.code).toBe(2); // ERROR
  });
});
