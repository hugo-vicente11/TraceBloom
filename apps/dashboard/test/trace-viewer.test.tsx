// @vitest-environment jsdom

/**
 * Rendering smoke test for the trace viewer: a small agent-shaped fixture is
 * rendered with Testing Library and we assert the tree rows, waterfall bars,
 * badges (error / retry / orphan / eval chips) and collapse behavior.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceViewer } from '../app/traces/[traceId]/TraceViewer';
import type { SpanDetail, SpanEvalResult, TraceSpan, TraceSummary } from '../lib/traces';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const ROOT = 'aaaa000000000001';
const CHAT = 'aaaa000000000002';
const TOOL_FAIL = 'aaaa000000000003';
const TOOL_RETRY = 'aaaa000000000004';
const ORPHAN = 'aaaa000000000005';

const spans: TraceSpan[] = [
  span({
    spanId: ROOT,
    name: 'invoke_agent researcher',
    operationName: 'invoke_agent',
    durationNs: 1_000_000_000,
  }),
  span({
    spanId: CHAT,
    parentSpanId: ROOT,
    name: 'chat gpt-4o',
    operationName: 'chat',
    requestModel: 'gpt-4o',
    startOffsetNs: 10_000_000,
    durationNs: 200_000_000,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.00075,
  }),
  span({
    spanId: TOOL_FAIL,
    parentSpanId: ROOT,
    name: 'execute_tool web.search',
    operationName: 'execute_tool',
    toolName: 'web.search',
    startOffsetNs: 220_000_000,
    durationNs: 80_000_000,
    statusCode: 'ERROR',
    statusMessage: 'rate limited',
  }),
  span({
    spanId: TOOL_RETRY,
    parentSpanId: ROOT,
    name: 'execute_tool web.search',
    operationName: 'execute_tool',
    toolName: 'web.search',
    startOffsetNs: 320_000_000,
    durationNs: 90_000_000,
    retryAttempt: 2,
  }),
  span({
    spanId: ORPHAN,
    parentSpanId: 'ffff000000000000',
    name: 'stray step',
    startOffsetNs: 500_000_000,
    durationNs: 10_000_000,
  }),
];

const trace: TraceSummary = {
  traceId: 'f'.repeat(32),
  startTime: '2026-07-10T12:00:00.000Z',
  durationNs: 1_000_000_000,
  spanCount: spans.length,
  errorCount: 1,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  costUsd: 0.00075,
  serviceNames: ['demo'],
  models: ['gpt-4o'],
};

const evalResults: SpanEvalResult[] = [
  {
    spanId: CHAT,
    evalId: 'eval-1',
    evaluationName: 'answer-quality',
    evalVersion: 2,
    scoreValue: 0.9,
    scoreLabel: 'pass',
    passed: true,
    explanation: 'solid answer',
    errorType: '',
    evaluatorType: 'llm_judge',
  },
];

function renderViewer(initialSpanId?: string) {
  return render(
    <TraceViewer
      trace={trace}
      spans={spans}
      evalResults={evalResults}
      truncated={false}
      initialSpanId={initialSpanId}
    />,
  );
}

describe('TraceViewer', () => {
  it('renders every span row with names, badges and eval chips', () => {
    renderViewer();

    expect(screen.getByText('invoke_agent researcher')).toBeDefined();
    expect(screen.getAllByText('execute_tool web.search')).toHaveLength(2);
    expect(screen.getByText('stray step')).toBeDefined();
    expect(screen.getByText('5 spans · 1 orphaned')).toBeDefined();

    // Error, retry and orphan badges.
    expect(screen.getByText('error')).toBeDefined();
    expect(screen.getByText('↻ ×2')).toBeDefined();
    expect(screen.getByText('orphan')).toBeDefined();

    // The eval score chip rendered on the chat span.
    expect(screen.getByText('✓ 0.90')).toBeDefined();
    expect(screen.getByTitle(/answer-quality: 0.90 — solid answer/)).toBeDefined();
  });

  it('collapses and expands a subtree', () => {
    renderViewer();

    // Collapse the root: its three children disappear, the "+4" count shows
    // (subtree includes the descendants), the orphan root stays.
    fireEvent.click(screen.getByTitle('Collapse subtree'));
    expect(screen.queryByText('chat gpt-4o')).toBeNull();
    expect(screen.getByText('stray step')).toBeDefined();
    expect(screen.getByText('+3')).toBeDefined();

    fireEvent.click(screen.getByTitle('Expand subtree'));
    expect(screen.getByText('chat gpt-4o')).toBeDefined();
  });

  it('collapse all / expand all buttons work', () => {
    renderViewer();
    fireEvent.click(screen.getByText('Collapse all'));
    expect(screen.queryByText('chat gpt-4o')).toBeNull();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByText('chat gpt-4o')).toBeDefined();
  });

  it('marks the deep-linked span as selected', () => {
    renderViewer(CHAT);
    const row = document.getElementById(`span-row-${CHAT}`);
    expect(row?.getAttribute('aria-selected')).toBe('true');
  });

  it('positions waterfall bars by start offset and duration', () => {
    renderViewer();
    const bar = screen.getByTitle(/chat gpt-4o — 200.0 ms @ \+10.0 ms/);
    expect(bar.style.left).toBe('1%');
    expect(bar.style.width).toContain('20%');
  });

  it('flags the error bar with the status color and message', () => {
    renderViewer();
    const bar = screen.getByTitle(/ERROR: rate limited/);
    expect(bar.style.backgroundColor).toBe('rgb(208, 59, 59)'); // #d03b3b
  });

  it('virtualizes large traces: only a window of rows is mounted', () => {
    const many: TraceSpan[] = [
      span({ spanId: 'r000000000000000', name: 'root', durationNs: 2_000_000_000 }),
    ];
    for (let i = 1; i < 2000; i++) {
      many.push(
        span({
          spanId: `s${i.toString().padStart(15, '0')}`,
          parentSpanId: 'r000000000000000',
          name: `step ${i}`,
          startOffsetNs: i * 1_000_000,
        }),
      );
    }
    const { container } = render(
      <TraceViewer
        trace={{ ...trace, spanCount: many.length, durationNs: 2_000_000_000 }}
        spans={many}
        evalResults={[]}
        truncated={false}
      />,
    );

    const mounted = container.querySelectorAll('[role="treeitem"]').length;
    expect(mounted).toBeGreaterThan(10); // the visible window renders
    expect(mounted).toBeLessThan(100); // ...but nowhere near all 2,000 rows
    // The scrollbar still represents the full list via the spacer height.
    const spacer = container.querySelector('[role="tree"] > div') as HTMLElement;
    expect(spacer.style.height).toBe(`${many.length * 28}px`);
  });
});

function spanDetail(overrides: Partial<SpanDetail>): SpanDetail {
  return {
    spanId: CHAT,
    parentSpanId: ROOT,
    name: 'chat gpt-4o',
    kind: 'CLIENT',
    statusCode: 'OK',
    statusMessage: '',
    serviceName: 'demo',
    scopeName: '@tracebloom/sdk',
    operationName: 'chat',
    provider: 'openai',
    requestModel: 'gpt-4o',
    responseModel: 'gpt-4o',
    responseId: 'chatcmpl-1',
    finishReasons: ['stop'],
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.00075,
    startTime: '2026-07-10 12:00:00.010',
    durationNs: 200_000_000,
    attributes: { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.prompt.version': 'v2' },
    resourceAttributes: { 'service.name': 'demo' },
    events: [],
    ...overrides,
  };
}

function stubFetch(payload: SpanDetail | { error: string }, ok = true) {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('SpanDetailPanel (via row click)', () => {
  it('lazy-loads content events and shows them with eval rationale', async () => {
    const mock = stubFetch(
      spanDetail({
        events: [
          {
            index: 0,
            name: 'gen_ai.user.message',
            timestamp: 't',
            body: { content: 'What is TraceBloom?' },
          },
          {
            index: 1,
            name: 'gen_ai.choice',
            timestamp: 't',
            body: { index: 0, finish_reason: 'stop', content: 'An LLM tracer.' },
          },
        ],
      }),
    );
    renderViewer();

    // Nothing is fetched until a span is clicked (lazy loading).
    expect(mock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('chat gpt-4o'));
    expect(mock).toHaveBeenCalledWith(
      `/api/traces/${trace.traceId}/spans/${CHAT}`,
      expect.anything(),
    );

    await waitFor(() => {
      expect(screen.getByText('What is TraceBloom?')).toBeDefined();
    });
    expect(screen.getByText('An LLM tracer.')).toBeDefined();
    // Eval score + judge rationale for this span (from the trace-level fetch).
    expect(screen.getByText('answer-quality')).toBeDefined();
    expect(screen.getByText('solid answer')).toBeDefined();
  });

  it('explains the capture toggle when no content events exist', async () => {
    stubFetch(spanDetail({ events: [] }));
    renderViewer();
    fireEvent.click(screen.getByText('chat gpt-4o'));

    await waitFor(() => {
      expect(screen.getByText(/No content captured for this span/)).toBeDefined();
    });
    expect(screen.getByText('TRACEBLOOM_CAPTURE_CONTENT=1')).toBeDefined();
  });

  it('shows an error state with a retry button when the fetch fails', async () => {
    stubFetch({ error: 'clickhouse unreachable' }, false);
    renderViewer();
    fireEvent.click(screen.getByText('chat gpt-4o'));

    await waitFor(() => {
      expect(screen.getByText('Could not load span detail')).toBeDefined();
    });
    expect(screen.getByText('clickhouse unreachable')).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });
});
