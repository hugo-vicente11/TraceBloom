// @vitest-environment jsdom

/**
 * Live rendering: pending placeholder rows with growing bars (TraceViewer
 * with the `live` prop), and the full client wiring, TraceView + the
 * useLiveTrace hook fed by a stubbed EventSource: spans appear on `delta`
 * messages, placeholders resolve (including to ERROR), eval chips pop in,
 * `end` flips the badge, and unmount closes the stream.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceView } from '../app/traces/[traceId]/TraceView';
import { TraceViewer } from '../app/traces/[traceId]/TraceViewer';
import type { LiveDelta, LiveSpan } from '../lib/live';
import type { SpanEvalResult, TraceDetail, TraceSpan, TraceSummary } from '../lib/traces';

const TRACE_ID = 'f'.repeat(32);
const ROOT = 'aaaa000000000001';
const CHAT = 'aaaa000000000002';
const TOOL = 'aaaa000000000003';

function span(overrides: Partial<TraceSpan> & { spanId: string; name: string }): TraceSpan {
  return {
    parentSpanId: '',
    kind: 'INTERNAL',
    statusCode: 'OK',
    statusMessage: '',
    serviceName: 'demo',
    operationName: '',
    provider: '',
    requestModel: '',
    responseModel: '',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    startOffsetNs: 0,
    durationNs: 100_000_000,
    toolName: '',
    promptVersion: '',
    retryAttempt: 0,
    ingestedMs: 0,
    ...overrides,
  };
}

function summary(spans: TraceSpan[], overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    traceId: TRACE_ID,
    startTime: '2026-07-17T12:00:00.000Z',
    durationNs: Math.max(...spans.map((s) => s.startOffsetNs + s.durationNs), 1),
    spanCount: spans.length,
    errorCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    serviceNames: ['demo'],
    models: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TraceViewer live mode (pending placeholders + growing bars)', () => {
  // Children arrived; their parent (the root) is still open.
  const spans = [
    span({ spanId: CHAT, parentSpanId: ROOT, name: 'chat gpt-4o', startOffsetNs: 100_000_000 }),
    span({
      spanId: TOOL,
      parentSpanId: ROOT,
      name: 'execute_tool web.search',
      startOffsetNs: 400_000_000,
      durationNs: 50_000_000,
    }),
  ];

  it('renders a pending placeholder root with a growing bar and running badges', () => {
    render(
      <TraceViewer
        trace={summary(spans)}
        spans={spans}
        evalResults={[]}
        truncated={false}
        live={{ running: true, nowOffsetNs: 1_000_000_000 }}
      />,
    );

    // Toolbar: real spans counted separately from the synthesized one.
    expect(screen.getByText('2 spans · 1 running')).toBeDefined();
    expect(screen.getByText('running…')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();

    // Placeholder bar: starts at its earliest child (100ms of the 1s "now"
    // timeline = 10%) and grows to now (width 90%).
    const bar = screen.getByTitle(/still running — 900.0 ms elapsed @ \+100.0 ms/);
    expect(bar.style.left).toBe('10%');
    expect(bar.style.width).toBe('90%');
    expect(bar.className).toContain('animate-pulse');

    // Completed children render as usual against the ticking total.
    const chat = screen.getByTitle(/chat gpt-4o — 100.0 ms @ \+100.0 ms/);
    expect(chat.style.width).toBe('10%');

    // A pending row cannot be opened (no landed span behind it).
    const row = document.getElementById(`span-row-${ROOT}`);
    expect(row?.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByText('running…'));
    expect(row?.getAttribute('aria-selected')).toBe('false');
  });

  it('completed traces never synthesize placeholders (M3 path untouched)', () => {
    render(<TraceViewer trace={summary(spans)} spans={spans} evalResults={[]} truncated={false} />);
    expect(screen.queryByText(/running/)).toBeNull();
    expect(screen.getByText('2 spans · 2 orphaned')).toBeDefined();
  });
});

/** Minimal EventSource stub: records instances, lets tests push messages. */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: StubEventSource[] = [];

  readyState = StubEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.readyState = StubEventSource.CLOSED;
  }

  open(): void {
    this.readyState = StubEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }
  }
}

/** Absolute ns for "offset into a trace that started `agoMs` ago". */
function absoluteNs(startedAgoMs: number, offsetNs: number): string {
  return (BigInt(Date.now() - startedAgoMs) * 1_000_000n + BigInt(offsetNs)).toString();
}

function liveSpanWire(base: TraceSpan, startNs: string, ingestedMs: number): LiveSpan {
  const { startOffsetNs, ...rest } = base;
  return { ...rest, startNs, ingestedMs };
}

function runningDetail(anchorNs: string, spans: TraceSpan[]): TraceDetail {
  return {
    trace: summary(spans),
    spans,
    evalResults: [],
    truncated: false,
    cursor: { spanMs: 1_000, evalMs: 0 },
    anchorStartNs: anchorNs,
    running: true,
  };
}

describe('TraceView live wiring (stubbed EventSource)', () => {
  beforeEach(() => {
    StubEventSource.instances = [];
    vi.stubGlobal('EventSource', StubEventSource);
  });

  it('streams spans in, resolves the pending root to an ERROR, pops eval chips, ends', () => {
    const anchor = absoluteNs(2_000, 0);
    const first = span({
      spanId: CHAT,
      parentSpanId: ROOT,
      name: 'chat gpt-4o',
      startOffsetNs: 50_000_000,
    });
    render(<TraceView detail={runningDetail(anchor, [first])} />);

    // Subscribed with the snapshot cursor; pending root + LIVE badge shown.
    expect(StubEventSource.instances).toHaveLength(1);
    const source = StubEventSource.instances[0]!;
    expect(source.url).toBe(`/api/traces/${TRACE_ID}/live?cursor=s1000e0`);
    act(() => source.open());
    expect(screen.getByText('LIVE')).toBeDefined();
    expect(screen.getByText('running…')).toBeDefined();
    expect(screen.getByText('1 spans · 1 running')).toBeDefined();

    // Delta 1: a tool span lands under the still-pending root.
    const tool = span({
      spanId: TOOL,
      parentSpanId: ROOT,
      name: 'execute_tool web.search',
      startOffsetNs: 300_000_000,
      totalTokens: 25,
    });
    act(() =>
      source.emit('delta', {
        spans: [liveSpanWire(tool, absoluteNs(2_000, 300_000_000), 2_000)],
        evals: [],
        cursor: { spanMs: 2_000, evalMs: 0 },
        rootSeen: false,
      } satisfies LiveDelta),
    );
    expect(screen.getByText('execute_tool web.search')).toBeDefined();
    expect(screen.getByText('2 spans · 1 running')).toBeDefined();

    // Delta 2: the root arrives: as an ERROR. Placeholder resolves in
    // place: status flips, LIVE badge is replaced by the error chip.
    const root = span({
      spanId: ROOT,
      name: 'invoke_agent researcher',
      startOffsetNs: 0,
      durationNs: 900_000_000,
      statusCode: 'ERROR',
      statusMessage: 'agent crashed',
    });
    act(() =>
      source.emit('delta', {
        spans: [liveSpanWire(root, anchor, 3_000)],
        evals: [],
        cursor: { spanMs: 3_000, evalMs: 0 },
        rootSeen: true,
      } satisfies LiveDelta),
    );
    expect(screen.queryByText('running…')).toBeNull();
    expect(screen.getByText('invoke_agent researcher')).toBeDefined();
    expect(screen.getByText('error')).toBeDefined();
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.getByText('1 error')).toBeDefined();

    // Delta 3: the async evaluator scores the chat span, chip pops in.
    const evalResult: SpanEvalResult = {
      spanId: CHAT,
      evalId: 'eval-1',
      evaluationName: 'answer-quality',
      evalVersion: 1,
      scoreValue: 0.9,
      scoreLabel: 'pass',
      passed: true,
      explanation: 'solid',
      errorType: '',
      evaluatorType: 'llm_judge',
      evaluatedMs: 4_000,
    };
    act(() =>
      source.emit('delta', {
        spans: [],
        evals: [evalResult],
        cursor: { spanMs: 3_000, evalMs: 4_000 },
        rootSeen: false,
      } satisfies LiveDelta),
    );
    expect(screen.getByText('✓ 0.90')).toBeDefined();

    // Terminal end: the stream closes for good.
    act(() => source.emit('end', { reason: 'complete' }));
    expect(source.readyState).toBe(StubEventSource.CLOSED);
  });

  it('shows reconnecting on transient errors and unavailable on fatal ones', () => {
    render(
      <TraceView
        detail={runningDetail(absoluteNs(2_000, 0), [
          span({ spanId: CHAT, parentSpanId: ROOT, name: 'chat gpt-4o' }),
        ])}
      />,
    );
    const source = StubEventSource.instances[0]!;
    act(() => source.open());
    expect(screen.getByText('LIVE')).toBeDefined();

    // Browser is auto-retrying (readyState CONNECTING).
    act(() => {
      source.readyState = StubEventSource.CONNECTING;
      source.onerror?.();
    });
    expect(screen.getByText('LIVE · reconnecting…')).toBeDefined();

    // Browser gave up (non-200 → CLOSED): no retry loop.
    act(() => {
      source.readyState = StubEventSource.CLOSED;
      source.onerror?.();
    });
    expect(screen.getByText('live updates unavailable')).toBeDefined();
  });

  it('pauses on tab hide, resumes from the MERGED cursor on show, closes on unmount', () => {
    const detail = runningDetail(absoluteNs(2_000, 0), [
      span({ spanId: CHAT, parentSpanId: ROOT, name: 'chat gpt-4o' }),
    ]);
    const { unmount } = render(<TraceView detail={detail} />);
    const first = StubEventSource.instances[0]!;
    act(() => first.open());

    // A delta advances the cursor before the tab goes to the background.
    act(() =>
      first.emit('delta', {
        spans: [],
        evals: [],
        cursor: { spanMs: 7_777, evalMs: 42 },
        rootSeen: false,
      } satisfies LiveDelta),
    );

    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByText('LIVE · paused')).toBeDefined();
    expect(first.readyState).toBe(StubEventSource.CLOSED);

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Resumed with the merged cursor: no gap, no full re-fetch.
    expect(StubEventSource.instances).toHaveLength(2);
    const second = StubEventSource.instances[1]!;
    expect(second.url).toBe(`/api/traces/${TRACE_ID}/live?cursor=s7777e42`);

    unmount();
    expect(second.readyState).toBe(StubEventSource.CLOSED);
    hidden.mockRestore();
  });

  it('renders a completed trace statically: no EventSource at all', () => {
    const spans = [span({ spanId: ROOT, name: 'invoke_agent researcher' })];
    const detail: TraceDetail = { ...runningDetail(absoluteNs(2_000, 0), spans), running: false };
    render(<TraceView detail={detail} />);
    expect(StubEventSource.instances).toHaveLength(0);
    expect(screen.getByText('OK')).toBeDefined();
    expect(screen.queryByText(/LIVE/)).toBeNull();
  });
});

describe('Replay (completed traces re-animate arrival order)', () => {
  it('reveals spans by ingest order with placeholders, then restores evals', () => {
    vi.useFakeTimers();
    try {
      // Arrival order: chat, tool, then the root (roots complete last).
      const spans = [
        span({
          spanId: ROOT,
          name: 'invoke_agent researcher',
          durationNs: 900_000_000,
          ingestedMs: 3_000,
        }),
        span({
          spanId: CHAT,
          parentSpanId: ROOT,
          name: 'chat gpt-4o',
          startOffsetNs: 50_000_000,
          ingestedMs: 1_000,
        }),
        span({
          spanId: TOOL,
          parentSpanId: ROOT,
          name: 'execute_tool web.search',
          startOffsetNs: 300_000_000,
          ingestedMs: 2_000,
        }),
      ];
      const detail: TraceDetail = {
        trace: summary(spans),
        spans,
        evalResults: [
          {
            spanId: CHAT,
            evalId: 'eval-1',
            evaluationName: 'answer-quality',
            evalVersion: 1,
            scoreValue: 0.9,
            scoreLabel: 'pass',
            passed: true,
            explanation: '',
            errorType: '',
            evaluatorType: 'llm_judge',
          },
        ],
        truncated: false,
        cursor: { spanMs: 3_000, evalMs: 0 },
        anchorStartNs: '1782950400000000000',
        running: false,
      };
      render(<TraceView detail={detail} />);

      // Completed trace: eval chip is there, replay is offered.
      expect(screen.getByText('✓ 0.90')).toBeDefined();
      fireEvent.click(screen.getByText('▶ Replay arrival'));

      // Step 1: only the chat span, under a pending placeholder root; the
      // eval chips are hidden while the replay is in flight.
      expect(screen.getByText('chat gpt-4o')).toBeDefined();
      expect(screen.queryByText('execute_tool web.search')).toBeNull();
      expect(screen.getByText('running…')).toBeDefined();
      expect(screen.queryByText('✓ 0.90')).toBeNull();
      expect(screen.getByText('■ Stop replay · 1/3')).toBeDefined();

      // Step 2: the tool span arrives (arrival gaps are clamped to 1.2s).
      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(screen.getByText('execute_tool web.search')).toBeDefined();
      expect(screen.getByText('running…')).toBeDefined();

      // Step 3: the root arrives: placeholder resolves, evals return.
      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(screen.getByText('invoke_agent researcher')).toBeDefined();
      expect(screen.queryByText('running…')).toBeNull();
      expect(screen.getByText('✓ 0.90')).toBeDefined();

      // Stop restores the normal completed view.
      fireEvent.click(screen.getByText('■ Stop replay · 3/3'));
      expect(screen.getByText('▶ Replay arrival')).toBeDefined();
      expect(screen.getByText('3 spans')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never offers replay while the trace is running', () => {
    vi.stubGlobal('EventSource', StubEventSource);
    render(
      <TraceView
        detail={runningDetail(absoluteNs(2_000, 0), [
          span({ spanId: CHAT, parentSpanId: ROOT, name: 'chat gpt-4o' }),
        ])}
      />,
    );
    expect(screen.queryByText('▶ Replay arrival')).toBeNull();
  });
});
