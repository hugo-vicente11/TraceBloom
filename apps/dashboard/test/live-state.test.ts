/**
 * Cursor codec + incremental live-trace state: the no-gaps/no-dupes contract
 * is "inclusive delta bound + idempotent merge", so these tests hammer the
 * merge with overlapping and out-of-order deltas.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  decodeCursor,
  deriveTraceView,
  encodeCursor,
  type LiveCursor,
  type LiveDelta,
  type LiveSpan,
  maxCursor,
  seedLiveState,
} from '../lib/live';
import type { SpanEvalResult, TraceSpan } from '../lib/traces';

const TRACE_ID = 'a'.repeat(32);
/** 2026-07-01T00:00:00Z in nanoseconds — realistically beyond 2^53. */
const BASE_NS = 1_782_950_400_000_000_000n;

function liveSpan(overrides: Partial<LiveSpan> & { spanId: string }): LiveSpan {
  return {
    parentSpanId: '',
    name: `span ${overrides.spanId}`,
    kind: 'INTERNAL',
    statusCode: 'OK',
    statusMessage: '',
    serviceName: 'svc',
    operationName: '',
    provider: '',
    requestModel: '',
    responseModel: '',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    startNs: BASE_NS.toString(),
    durationNs: 1_000_000,
    toolName: '',
    promptVersion: '',
    retryAttempt: 0,
    ingestedMs: 1,
    ...overrides,
  };
}

function snapshotSpan(overrides: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  const { startNs, ...rest } = liveSpan({ spanId: overrides.spanId });
  return { ...rest, startOffsetNs: 0, ...overrides };
}

function evalResult(spanId: string, overrides: Partial<SpanEvalResult> = {}): SpanEvalResult {
  return {
    spanId,
    evalId: 'eval-1',
    evaluationName: 'json-valid',
    evalVersion: 1,
    scoreValue: 1,
    scoreLabel: 'pass',
    passed: true,
    explanation: '',
    errorType: '',
    evaluatorType: 'deterministic',
    ...overrides,
  };
}

function delta(overrides: Partial<LiveDelta>): LiveDelta {
  return { spans: [], evals: [], cursor: { spanMs: 0, evalMs: 0 }, rootSeen: false, ...overrides };
}

function seed(spans: TraceSpan[] = [], cursor: LiveCursor = { spanMs: 0, evalMs: 0 }) {
  return seedLiveState({
    traceId: TRACE_ID,
    anchorStartNs: BASE_NS.toString(),
    spans,
    evalResults: [],
    cursor,
    rootSeen: false,
  });
}

describe('cursor codec', () => {
  it('round-trips', () => {
    const cursor: LiveCursor = { spanMs: 1_752_600_000_123, evalMs: 1_752_600_000_456 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed cursors', () => {
    for (const bad of ['', 's1', 'e1', 's1e', 'sxe1', 's-1e2', 's1e2extra', '1e2']) {
      expect(decodeCursor(bad)).toBeUndefined();
    }
  });

  it('maxCursor advances each dimension independently', () => {
    expect(maxCursor({ spanMs: 5, evalMs: 1 }, { spanMs: 2, evalMs: 9 })).toEqual({
      spanMs: 5,
      evalMs: 9,
    });
  });
});

describe('applyDelta', () => {
  it('adds new spans and advances the cursor', () => {
    const s0 = seed();
    const s1 = applyDelta(
      s0,
      delta({
        spans: [liveSpan({ spanId: 'b1', parentSpanId: 'r1' })],
        cursor: { spanMs: 100, evalMs: 0 },
      }),
    );
    expect(s1.spans.size).toBe(1);
    expect(s1.cursor).toEqual({ spanMs: 100, evalMs: 0 });
    expect(s1.rootSeen).toBe(false);
  });

  it('is idempotent: overlapping deltas (inclusive boundary re-fetch) converge', () => {
    const rows = [liveSpan({ spanId: 'b1' }), liveSpan({ spanId: 'b2' })];
    const s1 = applyDelta(seed(), delta({ spans: rows, cursor: { spanMs: 10, evalMs: 0 } }));
    // The same rows re-delivered (reconnect replay) change nothing.
    const s2 = applyDelta(s1, delta({ spans: rows, cursor: { spanMs: 10, evalMs: 0 } }));
    expect(s2).toBe(s1);
  });

  it('returns the same state for an empty tick (zero re-renders)', () => {
    const s1 = applyDelta(seed(), delta({ spans: [liveSpan({ spanId: 'b1' })] }));
    expect(applyDelta(s1, delta({}))).toBe(s1);
  });

  it('keeps the highest eval version per (eval, span) regardless of order', () => {
    const v2 = evalResult('b1', { evalVersion: 2, scoreValue: 0.9 });
    const v1 = evalResult('b1', { evalVersion: 1, scoreValue: 0.1 });
    const s1 = applyDelta(seed(), delta({ evals: [v2] }));
    const s2 = applyDelta(s1, delta({ evals: [v1] }));
    expect([...s2.evals.values()]).toEqual([v2]);

    // Same eval on a different span is a separate entry, not an overwrite.
    const other = evalResult('b2');
    const s3 = applyDelta(s2, delta({ evals: [other] }));
    expect(s3.evals.size).toBe(2);
  });

  it('latches rootSeen once a root span arrives', () => {
    const s1 = applyDelta(
      seed(),
      delta({ spans: [liveSpan({ spanId: 'r1', parentSpanId: '' })], rootSeen: true }),
    );
    expect(s1.rootSeen).toBe(true);
    // A later delta without a root does not un-latch it.
    expect(applyDelta(s1, delta({ spans: [liveSpan({ spanId: 'b9' })] })).rootSeen).toBe(true);
  });
});

describe('deriveTraceView', () => {
  it('re-anchors offsets when a span arrives that starts before all others', () => {
    const s1 = applyDelta(
      seed(),
      delta({ spans: [liveSpan({ spanId: 'b1', startNs: (BASE_NS + 5_000n).toString() })] }),
    );
    expect(deriveTraceView(s1).spans[0]?.startOffsetNs).toBe(0);

    // The (late-exported) root starts 5µs earlier: b1 shifts right.
    const s2 = applyDelta(
      s1,
      delta({ spans: [liveSpan({ spanId: 'r1', startNs: BASE_NS.toString() })], rootSeen: true }),
    );
    const view = deriveTraceView(s2);
    const byId = new Map(view.spans.map((s) => [s.spanId, s]));
    expect(byId.get('r1')?.startOffsetNs).toBe(0);
    expect(byId.get('b1')?.startOffsetNs).toBe(5_000);
    expect(view.anchorStartNs).toBe(BASE_NS.toString());
    expect(view.running).toBe(false);
  });

  it('aggregates the summary from merged spans', () => {
    const s1 = applyDelta(
      seed(),
      delta({
        spans: [
          liveSpan({
            spanId: 'b1',
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            costUsd: 0.001,
            requestModel: 'gpt-4o',
            durationNs: 2_000_000,
          }),
          liveSpan({ spanId: 'b2', statusCode: 'ERROR', serviceName: 'other' }),
        ],
      }),
    );
    const { trace, running } = deriveTraceView(s1);
    expect(trace.spanCount).toBe(2);
    expect(trace.errorCount).toBe(1);
    expect(trace.totalTokens).toBe(15);
    expect(trace.costUsd).toBeCloseTo(0.001);
    expect(trace.durationNs).toBe(2_000_000);
    expect(trace.models).toEqual(['gpt-4o']);
    expect(trace.serviceNames).toEqual(['other', 'svc']);
    expect(running).toBe(true);
  });

  it('round-trips a server snapshot through seedLiveState', () => {
    const state = seed([
      snapshotSpan({ spanId: 'r1', startOffsetNs: 0, durationNs: 3_000 }),
      snapshotSpan({ spanId: 'b1', parentSpanId: 'r1', startOffsetNs: 1_000, durationNs: 500 }),
    ]);
    const view = deriveTraceView(state);
    const byId = new Map(view.spans.map((s) => [s.spanId, s]));
    expect(byId.get('b1')?.startOffsetNs).toBe(1_000);
    expect(view.trace.durationNs).toBe(3_000);
  });
});
