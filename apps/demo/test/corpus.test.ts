import type { EvalDefinition } from '@tracebloom/db';
import { describe, expect, it } from 'vitest';
import { DEMO_SERVICE, DEMO_VARIANTS, generateCorpus } from '../src/corpus.js';
import { buildEvalResults } from '../src/evals.js';

const NOW = Date.parse('2026-07-19T12:00:00Z');
const HOUR = 3_600_000;

// Mirrors the runner's defaults (env.ts): a regression needs >= 10 samples per
// variant and a drop > 0.1 in mean score or pass rate over the 24h window.
const MIN_SAMPLES = 10;
const DROP_THRESHOLD = 0.1;

const DEFS: EvalDefinition[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'no-refusal',
    type: 'deterministic',
    version: 1,
    config: {
      target: 'output',
      mode: 'all',
      rules: [
        { kind: 'not_contains', text: 'I cannot', caseSensitive: false },
        { kind: 'not_contains', text: 'as an AI', caseSensitive: false },
        { kind: 'max_length', max: 4000 },
      ],
    },
    selector: { operations: ['chat'], samplingRate: 1 },
    enabled: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'answer-quality',
    type: 'llm_judge',
    version: 1,
    config: { model: 'gpt-4o-mini', criteria: 'x', scale: { min: 1, max: 5 }, passThreshold: 0.6 },
    selector: { operations: ['chat'], samplingRate: 1 },
    enabled: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  },
];

describe('generateCorpus', () => {
  const corpus = generateCorpus({ nowMs: NOW });

  it('is deterministic for a fixed (now, seed)', () => {
    const again = generateCorpus({ nowMs: NOW });
    expect(JSON.stringify(again.spans)).toEqual(JSON.stringify(corpus.spans));
    expect(JSON.stringify(again.events)).toEqual(JSON.stringify(corpus.events));
  });

  it('produces a well-formed span tree per trace', () => {
    for (const trace of corpus.traces) {
      const ids = new Set(trace.spans.map((s) => s.span_id));
      expect(ids.size).toBe(trace.spans.length); // unique span ids
      const roots = trace.spans.filter((s) => s.parent_span_id === '');
      expect(roots).toHaveLength(1);
      for (const span of trace.spans) {
        if (span.parent_span_id !== '') {
          expect(ids.has(span.parent_span_id)).toBe(true);
        }
        expect(Date.parse(`${span.end_time.replace(' ', 'T')}Z`)).toBeGreaterThanOrEqual(
          Date.parse(`${span.start_time.replace(' ', 'T')}Z`),
        );
        expect(span.service_name).toBe(DEMO_SERVICE);
      }
    }
  });

  it('contains the demo story beats: retries, hard failures, parallel fetches', () => {
    const retrySpans = corpus.spans.filter((s) =>
      s.attributes_json.includes('"tracebloom.retry.attempt":2'),
    );
    expect(retrySpans.length).toBeGreaterThanOrEqual(5);

    const failedRoots = corpus.spans.filter(
      (s) => s.parent_span_id === '' && s.status_code === 'ERROR',
    );
    expect(failedRoots.length).toBeGreaterThanOrEqual(2);

    // A hard-failure trace is truncated: no draft/summarizer chat spans.
    const failedTrace = corpus.traces.find((t) => t.hardFailure);
    expect(failedTrace).toBeDefined();
    expect(failedTrace?.chatSpans.map((c) => c.role)).toEqual(['plan']);

    const fetches = corpus.spans.filter((s) => s.name === 'execute_tool web.fetch');
    expect(fetches.length).toBeGreaterThan(80);
  });

  it('tags every chat span with its prompt variant', () => {
    for (const chat of corpus.chatSpans) {
      const attrs = JSON.parse(chat.row.attributes_json) as Record<string, unknown>;
      expect(attrs['gen_ai.prompt.version']).toBe(chat.variant);
      expect(chat.row.operation_name).toBe('chat');
    }
  });

  it('keeps content events aligned with chat spans', () => {
    const chatIds = new Set(corpus.chatSpans.map((c) => c.row.span_id));
    const contentEvents = corpus.events.filter((e) =>
      ['gen_ai.user.message', 'gen_ai.choice'].includes(e.name),
    );
    expect(contentEvents.length).toBe(corpus.chatSpans.length * 2);
    for (const event of contentEvents) {
      expect(chatIds.has(event.span_id)).toBe(true);
    }
  });
});

describe('buildEvalResults', () => {
  it('guarantees the v2 pass-rate regression in the 24h window', async () => {
    const corpus = generateCorpus({ nowMs: NOW });
    const rows = await buildEvalResults(corpus.chatSpans, DEFS);

    const inWindow = rows.filter(
      (r) =>
        r.evaluation_name === 'no-refusal' &&
        Date.parse(`${r.span_start_time.replace(' ', 'T')}Z`) >= NOW - 24 * HOUR,
    );
    const stats = (variant: string) => {
      const of = inWindow.filter((r) => r.variant === variant);
      return {
        samples: of.length,
        passRate: of.filter((r) => r.passed === 1).length / of.length,
        meanScore: of.reduce((sum, r) => sum + r.score_value, 0) / of.length,
      };
    };
    const v1 = stats(DEMO_VARIANTS.baseline);
    const v2 = stats(DEMO_VARIANTS.regressed);

    expect(v1.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(v2.samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
    // The drop the runner's detector must see (with margin over the threshold).
    expect(v1.passRate - v2.passRate).toBeGreaterThan(DROP_THRESHOLD + 0.03);
  });

  it('scores refusal drafts as judge failures with a rationale', async () => {
    const corpus = generateCorpus({ nowMs: NOW });
    const rows = await buildEvalResults(corpus.chatSpans, DEFS);
    const refusalSpanIds = new Set(
      corpus.chatSpans.filter((c) => c.refusal).map((c) => c.row.span_id),
    );
    const judgeRefusals = rows.filter(
      (r) => r.evaluation_name === 'answer-quality' && refusalSpanIds.has(r.span_id),
    );
    expect(judgeRefusals.length).toBe(refusalSpanIds.size);
    for (const row of judgeRefusals) {
      expect(row.passed).toBe(0);
      expect(row.score_value).toBeLessThan(0.6);
      expect(row.explanation.length).toBeGreaterThan(10);
    }
  });

  it('computes no-refusal scores with the real deterministic evaluator', async () => {
    const corpus = generateCorpus({ nowMs: NOW });
    const rows = await buildEvalResults(corpus.chatSpans, DEFS);
    const byId = new Map(corpus.chatSpans.map((c) => [c.row.span_id, c]));
    for (const row of rows.filter((r) => r.evaluation_name === 'no-refusal')) {
      const chat = byId.get(row.span_id);
      expect(chat).toBeDefined();
      if (chat?.refusal) {
        // One or two of the three rules fail (one refusal template contains
        // both banned phrases) -> score 2/3 or 1/3, overall fail under mode=all.
        expect(row.passed).toBe(0);
        expect([1 / 3, 2 / 3].some((s) => Math.abs(row.score_value - s) < 1e-9)).toBe(true);
      } else {
        expect(row.passed).toBe(1);
        expect(row.score_value).toBe(1);
      }
    }
  });
});
