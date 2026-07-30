/**
 * Proof that live streaming cannot impact ingestion (DECISIONS.md D21).
 *
 * The collector is a separate PROCESS the live channel never talks to, the
 * only shared resource is ClickHouse, so the bound that matters is read
 * load. Two guards:
 *
 * 1. A load sweep: delta fetches are a function of poll ticks (per watched
 *    trace), NOT of subscriber count: 1, 5 or 25 tabs on one trace issue
 *    identical query counts, and every query is cursor-bounded to one trace.
 * 2. A source-level contract: the live server modules stay read-only (no
 *    inserts/mutations) and never reference the collector, so the isolation
 *    cannot silently regress.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveCursor, LiveDelta } from '../lib/live';
import { type BrokerConfig, LiveBroker, type LiveSubscriber } from '../lib/live-broker';

const CONFIG: Omit<BrokerConfig, 'fetchDeltas'> = {
  fastPollMs: 100,
  slowPollMs: 300,
  settledEndMs: 60_000,
  deadEndMs: 60_000,
  maxConsecutiveErrors: 3,
  maxSubscribers: 100,
  maxSubscribersPerTrace: 50,
};

function silentSubscriber(): LiveSubscriber {
  return { send: () => true, end: () => {}, close: () => {} };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run a broker with N subscribers on `traces` for windowMs; count fetches. */
async function sweep(subscribersPerTrace: number, traces: string[], windowMs: number) {
  const calls: Array<{ traceId: string; cursor: LiveCursor }> = [];
  const fetchDeltas = async (traceId: string, cursor: LiveCursor): Promise<LiveDelta> => {
    calls.push({ traceId, cursor });
    // A quiet trace: pure polling overhead, the worst case for read load.
    return { spans: [], evals: [], cursor, rootSeen: false };
  };
  const broker = new LiveBroker({ fetchDeltas, ...CONFIG });
  const unsubscribes: Array<() => void> = [];
  for (const traceId of traces) {
    for (let i = 0; i < subscribersPerTrace; i++) {
      const result = broker.subscribe(traceId, { spanMs: 0, evalMs: 0 }, silentSubscriber());
      if (!result.ok) {
        throw new Error('subscribe failed');
      }
      unsubscribes.push(result.unsubscribe);
    }
  }
  await vi.advanceTimersByTimeAsync(windowMs);
  for (const unsubscribe of unsubscribes) {
    unsubscribe();
  }
  return { calls, stats: broker.stats() };
}

describe('ingest isolation: read load is bounded by watched traces, not subscribers', () => {
  it('1, 5 and 25 subscribers on one trace issue IDENTICAL fetch counts', async () => {
    const trace = 'a'.repeat(32);
    const one = await sweep(1, [trace], 2_000);
    const five = await sweep(5, [trace], 2_000);
    const twentyFive = await sweep(25, [trace], 2_000);

    expect(one.calls.length).toBeGreaterThan(0);
    expect(five.calls.length).toBe(one.calls.length);
    expect(twentyFive.calls.length).toBe(one.calls.length);
  });

  it('fetches scale linearly with watched traces (one poller each)', async () => {
    const single = await sweep(3, ['a'.repeat(32)], 2_000);
    const triple = await sweep(3, ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)], 2_000);
    expect(triple.calls.length).toBe(3 * single.calls.length);
  });

  it('every fetch is scoped to one trace and carries the caller cursor', async () => {
    const trace = 'd'.repeat(32);
    const { calls, stats } = await sweep(4, [trace], 1_000);
    for (const call of calls) {
      expect(call.traceId).toBe(trace);
      expect(call.cursor).toEqual({ spanMs: 0, evalMs: 0 });
    }
    // Nothing left running after the sweep.
    expect(stats).toMatchObject({ pollers: 0, subscribers: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ingest isolation: the live channel is read-only and collector-free', () => {
  const files = [
    'lib/live-deltas.ts',
    'lib/live-broker.ts',
    'lib/live-list.ts',
    'app/api/traces/[traceId]/live/route.ts',
    'app/api/traces/live/route.ts',
  ];
  // Comments legitimately EXPLAIN the collector relationship; the contract
  // is about code, so strip them before matching.
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  const sources = new Map(
    files.map((file) => [file, stripComments(readFileSync(join(__dirname, '..', file), 'utf8'))]),
  );

  it('never writes: no mutating SQL, no client insert/command API', () => {
    for (const [file, source] of sources) {
      expect(source, `${file} must stay read-only`).not.toMatch(
        /\b(INSERT\s+INTO|ALTER\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i,
      );
      expect(source, `${file} must not use the client insert API`).not.toMatch(
        /\.(insert|command|exec)\s*\(/,
      );
    }
  });

  it('never references the collector process (port or endpoint env)', () => {
    for (const [file, source] of sources) {
      expect(source, `${file} must not touch the collector`).not.toMatch(
        /4318|TRACEBLOOM_ENDPOINT|\/v1\/traces/,
      );
    }
  });

  it('delta SQL is cursor-bounded to one trace — no full-trace re-fetch', () => {
    const deltas = sources.get('lib/live-deltas.ts') ?? '';
    expect(deltas).toContain('trace_id = {traceId:String}');
    expect(deltas).toContain('ingested_at >= fromUnixTimestamp64Milli({spanMs:Int64}');
    expect(deltas).toContain('evaluated_at >= fromUnixTimestamp64Milli({evalMs:Int64}');
    expect(deltas).toMatch(/LIMIT \{cap:UInt32\}/);
  });
});
