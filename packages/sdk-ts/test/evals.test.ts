import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withToolSpan } from '../src/agent.js';
import { EVALUATION_RESULT_EVENT, recordEvaluation } from '../src/evals.js';
import { init, shutdown } from '../src/tracer.js';

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  init({ spanProcessor: new SimpleSpanProcessor(exporter) });
});

afterEach(async () => {
  await shutdown();
});

describe('recordEvaluation', () => {
  it('emits the canonical gen_ai.evaluation.result event on the active span', async () => {
    await withToolSpan('answer', () => {
      recordEvaluation('user_feedback', { score: 1, label: 'thumbs_up', reason: 'helpful' });
    });

    const span = exporter.getFinishedSpans()[0]!;
    const events = span.events.filter((e) => e.name === EVALUATION_RESULT_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes).toEqual({
      'gen_ai.evaluation.name': 'user_feedback',
      'gen_ai.evaluation.score.value': 1,
      'gen_ai.evaluation.score.label': 'thumbs_up',
      'gen_ai.evaluation.explanation': 'helpful',
    });
  });

  it('records an errored evaluation with error.type and no score', async () => {
    await withToolSpan('answer', () => {
      recordEvaluation('toxicity', { errorType: 'timeout', score: 0.4 });
    });

    const event = exporter
      .getFinishedSpans()[0]!
      .events.find((e) => e.name === EVALUATION_RESULT_EVENT);
    expect(event?.attributes).toEqual({
      'gen_ai.evaluation.name': 'toxicity',
      'error.type': 'timeout',
    });
  });

  it('is a no-op without an active span', () => {
    expect(() => {
      recordEvaluation('user_feedback', { score: 0.5 });
    }).not.toThrow();
  });

  it('throws when neither score nor errorType is given', () => {
    expect(() => {
      recordEvaluation('user_feedback', {});
    }).toThrow(TypeError);
  });
});
