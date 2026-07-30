import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChatCompletionResponse, instrumentOpenAI } from '../src/openai.js';
import { setPromptVersion } from '../src/prompt.js';
import { init, shutdown } from '../src/tracer.js';

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
    model: 'gpt-4o',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('prompt version tagging', () => {
  it('tags every span from a client instrumented with a promptVersion', async () => {
    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const client = instrumentOpenAI(
      { chat: { completions: { create: async () => fakeResponse() } } },
      { promptVersion: 'v2', promptName: 'summarize' },
    );

    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes['gen_ai.prompt.version']).toBe('v2');
    expect(span.attributes['gen_ai.prompt.name']).toBe('summarize');
  });

  it('setPromptVersion tags the active span and is a no-op without one', () => {
    // No active span: must not throw.
    expect(() => setPromptVersion('v9')).not.toThrow();

    init({ spanProcessor: new SimpleSpanProcessor(exporter) });
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('op');
    context.with(trace.setSpan(context.active(), span), () => {
      setPromptVersion('v3');
    });
    span.end();

    expect(exporter.getFinishedSpans()[0]!.attributes['gen_ai.prompt.version']).toBe('v3');
  });
});
