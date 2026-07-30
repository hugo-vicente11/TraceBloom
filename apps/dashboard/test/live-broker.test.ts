/**
 * Fan-out broker: one poller per trace shared by all subscribers, catch-up
 * for late joiners, bounded capacity, slow-consumer drops, and self-ending
 * pollers with no leaked timers. The fetch counter doubles as the
 * ingestion-isolation proof: ClickHouse reads scale with poll ticks, never
 * with subscriber count (see live-ingest-isolation.test.ts for the sweep).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveCursor, LiveDelta, LiveEnd, LiveSpan } from '../lib/live';
import { type BrokerConfig, LiveBroker, type LiveSubscriber } from '../lib/live-broker';

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);

function liveSpan(spanId: string, ingestedMs: number, parentSpanId = 'ffff'): LiveSpan {
  return {
    spanId,
    parentSpanId,
    name: `span ${spanId}`,
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
    startNs: '1782950400000000000',
    durationNs: 1,
    toolName: '',
    promptVersion: '',
    retryAttempt: 0,
    ingestedMs,
  };
}

/**
 * A scripted ClickHouse: rows keyed by their ingest watermark; each fetch
 * returns rows at/after the cursor, mirroring the real inclusive-bound query.
 */
class FakeDeltaSource {
  private spans: LiveSpan[] = [];
  calls: Array<{ traceId: string; cursor: LiveCursor }> = [];
  failures = 0;

  land(...spans: LiveSpan[]): void {
    this.spans.push(...spans);
  }

  fetch = async (traceId: string, cursor: LiveCursor): Promise<LiveDelta> => {
    this.calls.push({ traceId, cursor });
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('clickhouse unreachable');
    }
    const matched = this.spans.filter((span) => span.ingestedMs >= cursor.spanMs);
    let spanMs = cursor.spanMs;
    let rootSeen = false;
    for (const span of matched) {
      spanMs = Math.max(spanMs, span.ingestedMs);
      rootSeen = rootSeen || span.parentSpanId === '';
    }
    return { spans: matched, evals: [], cursor: { spanMs, evalMs: cursor.evalMs }, rootSeen };
  };
}

interface Recorded {
  subscriber: LiveSubscriber;
  deltas: LiveDelta[];
  ends: LiveEnd['reason'][];
  closes: number;
  spanIds: () => Set<string>;
}

function recorder(sendResult: () => boolean = () => true): Recorded {
  const rec: Recorded = {
    deltas: [],
    ends: [],
    closes: 0,
    subscriber: {
      send(delta) {
        rec.deltas.push(delta);
        return sendResult();
      },
      end(reason) {
        rec.ends.push(reason);
      },
      close() {
        rec.closes += 1;
      },
    },
    spanIds: () => new Set(rec.deltas.flatMap((delta) => delta.spans.map((span) => span.spanId))),
  };
  return rec;
}

const CONFIG: Omit<BrokerConfig, 'fetchDeltas'> = {
  fastPollMs: 100,
  slowPollMs: 300,
  settledEndMs: 1_000,
  deadEndMs: 5_000,
  maxConsecutiveErrors: 3,
  maxSubscribers: 6,
  maxSubscribersPerTrace: 3,
};

let source: FakeDeltaSource;
let broker: LiveBroker;

beforeEach(() => {
  vi.useFakeTimers();
  source = new FakeDeltaSource();
  broker = new LiveBroker({ fetchDeltas: source.fetch, ...CONFIG });
});

afterEach(() => {
  vi.useRealTimers();
});

function subscribe(traceId: string, cursor: LiveCursor, rec: Recorded): () => void {
  const result = broker.subscribe(traceId, cursor, rec.subscriber);
  if (!result.ok) {
    throw new Error(`expected subscribe to succeed, got ${result.reason}`);
  }
  return result.unsubscribe;
}

describe('LiveBroker', () => {
  it('streams newly landed spans to a subscriber in arrival order', async () => {
    const rec = recorder();
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);

    source.land(liveSpan('s1', 10));
    await vi.advanceTimersByTimeAsync(150);
    source.land(liveSpan('s2', 20), liveSpan('s3', 30));
    await vi.advanceTimersByTimeAsync(150);

    expect([...rec.spanIds()]).toEqual(['s1', 's2', 's3']);
    // Cursor ids are monotonically non-decreasing across messages.
    const watermarks = rec.deltas.map((delta) => delta.cursor.spanMs);
    expect(watermarks).toEqual([...watermarks].sort((a, b) => a - b));
  });

  it('shares ONE poller across subscribers of the same trace (bounded fan-out)', async () => {
    const recs = [recorder(), recorder(), recorder()];
    for (const rec of recs) {
      subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);
    }
    source.land(liveSpan('s1', 10));
    await vi.advanceTimersByTimeAsync(500);

    expect(broker.stats().pollers).toBe(1);
    // Every subscriber saw the span, but the fetch count is that of a single
    // poll loop: ClickHouse load did not multiply with the audience.
    for (const rec of recs) {
      expect(rec.spanIds().has('s1')).toBe(true);
    }
    const fetchesWithThree = source.calls.length;

    const solo = new FakeDeltaSource();
    const soloBroker = new LiveBroker({ fetchDeltas: solo.fetch, ...CONFIG });
    const soloRec = recorder();
    const result = soloBroker.subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, soloRec.subscriber);
    expect(result.ok).toBe(true);
    solo.land(liveSpan('s1', 10));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchesWithThree).toBe(solo.calls.length);
  });

  it('catches a late subscriber up from its own cursor without a gap', async () => {
    const early = recorder();
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, early);
    source.land(liveSpan('s1', 10), liveSpan('s2', 20));
    await vi.advanceTimersByTimeAsync(250);
    expect(early.spanIds()).toEqual(new Set(['s1', 's2']));

    // Joins with a cursor from before s2 landed: must receive s2 (catch-up)
    // plus everything that lands later (shared broadcast).
    const late = recorder();
    subscribe(TRACE_A, { spanMs: 15, evalMs: 0 }, late);
    await vi.advanceTimersByTimeAsync(50);
    source.land(liveSpan('s3', 30));
    await vi.advanceTimersByTimeAsync(250);

    expect(late.spanIds()).toEqual(new Set(['s2', 's3']));
  });

  it('enforces global and per-trace subscriber caps', () => {
    for (let i = 0; i < CONFIG.maxSubscribersPerTrace; i++) {
      subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, recorder());
    }
    expect(broker.canAccept(TRACE_A)).toBe(false);
    expect(broker.subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, recorder().subscriber)).toEqual({
      ok: false,
      reason: 'capacity',
    });

    // Another trace is still accepted: until the GLOBAL cap is reached.
    for (let i = 0; i < CONFIG.maxSubscribers - CONFIG.maxSubscribersPerTrace; i++) {
      subscribe(TRACE_B, { spanMs: 0, evalMs: 0 }, recorder());
    }
    expect(broker.canAccept('c'.repeat(32))).toBe(false);
  });

  it('drops a slow consumer (send=false) but keeps the rest streaming', async () => {
    const healthy = recorder();
    const slow = recorder(() => false);
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, healthy);
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, slow);

    source.land(liveSpan('s1', 10));
    await vi.advanceTimersByTimeAsync(150);
    expect(broker.stats().subscribers).toBe(1);

    source.land(liveSpan('s2', 20));
    await vi.advanceTimersByTimeAsync(150);
    expect(healthy.spanIds()).toEqual(new Set(['s1', 's2']));
    expect(slow.deltas.length).toBe(1); // nothing delivered after the drop
  });

  it('stops polling and removes the poller when the last subscriber leaves', async () => {
    const rec = recorder();
    const unsubscribe = subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);
    await vi.advanceTimersByTimeAsync(250);
    const fetchesBefore = source.calls.length;
    expect(fetchesBefore).toBeGreaterThan(0);

    unsubscribe();
    unsubscribe(); // idempotent
    expect(broker.stats()).toMatchObject({ pollers: 0, subscribers: 0 });

    // No timer survives the unsubscribe: time passing fetches nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(source.calls.length).toBe(fetchesBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('slows down after the root lands and ends the stream once settled', async () => {
    const rec = recorder();
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);

    source.land(liveSpan('child', 10), liveSpan('root', 20, ''));
    await vi.advanceTimersByTimeAsync(150);
    expect(rec.spanIds()).toEqual(new Set(['child', 'root']));

    // Root seen → slow cadence: in the next ~900ms only ~3 slow polls fit.
    const fetchesAtRoot = source.calls.length;
    await vi.advanceTimersByTimeAsync(900);
    expect(source.calls.length - fetchesAtRoot).toBeLessThanOrEqual(3);

    // settledEndMs after the last delta: terminal end, everything torn down.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.ends).toEqual(['complete']);
    expect(broker.stats()).toMatchObject({ pollers: 0, subscribers: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends an abandoned rootless trace as idle', async () => {
    const rec = recorder();
    subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);
    source.land(liveSpan('s1', 10));
    await vi.advanceTimersByTimeAsync(150);

    await vi.advanceTimersByTimeAsync(CONFIG.deadEndMs + CONFIG.fastPollMs);
    expect(rec.ends).toEqual(['idle']);
    expect(broker.stats()).toMatchObject({ pollers: 0, subscribers: 0 });
  });

  it('rides out transient fetch errors, closes (not ends) after too many', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rec = recorder();
      subscribe(TRACE_A, { spanMs: 0, evalMs: 0 }, rec);

      source.failures = 2; // fewer than maxConsecutiveErrors: recovers
      source.land(liveSpan('s1', 10));
      await vi.advanceTimersByTimeAsync(500);
      expect(rec.spanIds().has('s1')).toBe(true);
      expect(rec.closes).toBe(0);

      source.failures = CONFIG.maxConsecutiveErrors; // now trip the breaker
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rec.closes).toBe(1);
      expect(rec.ends).toEqual([]); // close ≠ end: the client may reconnect
      expect(broker.stats()).toMatchObject({ pollers: 0, subscribers: 0 });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
