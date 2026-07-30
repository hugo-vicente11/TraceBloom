import { describe, expect, it } from 'vitest';
import { buildSpanTree, categorize, flattenVisible } from '../lib/trace-tree';
import type { SpanEvalResult, TraceSpan } from '../lib/traces';

function span(overrides: Partial<TraceSpan> & { spanId: string }): TraceSpan {
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
    startOffsetNs: 0,
    durationNs: 1_000_000,
    toolName: '',
    promptVersion: '',
    retryAttempt: 0,
    ingestedMs: 0,
    ...overrides,
  };
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

describe('buildSpanTree', () => {
  it('links children to parents and orders them by start offset then span id', () => {
    const tree = buildSpanTree([
      span({ spanId: 'aaaa', startOffsetNs: 0 }),
      span({ spanId: 'dddd', parentSpanId: 'aaaa', startOffsetNs: 300 }),
      span({ spanId: 'cccc', parentSpanId: 'aaaa', startOffsetNs: 100 }),
      // Tie on startOffsetNs with cccc: span id must break it deterministically.
      span({ spanId: 'bbbb', parentSpanId: 'aaaa', startOffsetNs: 100 }),
      span({ spanId: 'eeee', parentSpanId: 'cccc', startOffsetNs: 150 }),
    ]);

    expect(tree.roots.map((n) => n.span.spanId)).toEqual(['aaaa']);
    const root = tree.roots[0]!;
    expect(root.children.map((n) => n.span.spanId)).toEqual(['bbbb', 'cccc', 'dddd']);
    expect(tree.byId.get('cccc')!.children.map((n) => n.span.spanId)).toEqual(['eeee']);
    expect(tree.byId.get('eeee')!.depth).toBe(2);
    expect(tree.nodeCount).toBe(5);
    expect(tree.orphanCount).toBe(0);
  });

  it('turns spans with a missing parent into orphaned roots', () => {
    const tree = buildSpanTree([
      span({ spanId: 'aaaa', startOffsetNs: 0 }),
      span({ spanId: 'bbbb', parentSpanId: 'gone', startOffsetNs: 50 }),
    ]);

    expect(tree.roots.map((n) => n.span.spanId)).toEqual(['aaaa', 'bbbb']);
    expect(tree.byId.get('bbbb')!.orphaned).toBe(true);
    expect(tree.byId.get('aaaa')!.orphaned).toBe(false);
    expect(tree.orphanCount).toBe(1);
  });

  it('handles a self-referencing span without looping', () => {
    const tree = buildSpanTree([span({ spanId: 'aaaa', parentSpanId: 'aaaa' })]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.orphaned).toBe(true);
  });

  it('cuts parent cycles deterministically and keeps every span', () => {
    const tree = buildSpanTree([
      span({ spanId: 'aaaa', parentSpanId: 'bbbb', startOffsetNs: 0 }),
      span({ spanId: 'bbbb', parentSpanId: 'aaaa', startOffsetNs: 10 }),
      span({ spanId: 'cccc', parentSpanId: 'bbbb', startOffsetNs: 20 }),
    ]);

    // The earliest cycle member (aaaa) becomes the root; bbbb stays its child.
    expect(tree.roots.map((n) => n.span.spanId)).toEqual(['aaaa']);
    expect(tree.roots[0]!.orphaned).toBe(true);
    expect(tree.nodeCount).toBe(3);
    const flat = flattenVisible(tree, new Set());
    expect(flat.map((n) => n.span.spanId).sort()).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('deduplicates span ids, keeping the first occurrence', () => {
    const tree = buildSpanTree([
      span({ spanId: 'aaaa', name: 'first' }),
      span({ spanId: 'aaaa', name: 'second' }),
    ]);
    expect(tree.nodeCount).toBe(1);
    expect(tree.byId.get('aaaa')!.span.name).toBe('first');
  });

  it('computes subtree roll-ups including the span itself', () => {
    const tree = buildSpanTree([
      span({ spanId: 'aaaa', totalTokens: 10, costUsd: 0.1, durationNs: 100 }),
      span({
        spanId: 'bbbb',
        parentSpanId: 'aaaa',
        totalTokens: 20,
        inputTokens: 15,
        outputTokens: 5,
        costUsd: 0.2,
        durationNs: 40,
        statusCode: 'ERROR',
      }),
      span({
        spanId: 'cccc',
        parentSpanId: 'bbbb',
        totalTokens: 5,
        costUsd: 0.05,
        durationNs: 10,
        retryAttempt: 2,
      }),
      span({ spanId: 'dddd', totalTokens: 1000, costUsd: 9 }), // separate root
    ]);

    const root = tree.byId.get('aaaa')!.rollup;
    expect(root.spanCount).toBe(3);
    expect(root.totalTokens).toBe(35);
    expect(root.costUsd).toBeCloseTo(0.35, 10);
    expect(root.durationNs).toBe(150);
    expect(root.errorCount).toBe(1);
    expect(root.retryCount).toBe(1);

    const mid = tree.byId.get('bbbb')!.rollup;
    expect(mid.spanCount).toBe(2);
    expect(mid.totalTokens).toBe(25);
    expect(mid.errorCount).toBe(1);

    // The sibling root's totals must not leak into aaaa's subtree.
    expect(root.costUsd).toBeLessThan(1);
  });

  it('attaches eval results to their span and rolls them up to ancestors', () => {
    const tree = buildSpanTree(
      [
        span({ spanId: 'aaaa' }),
        span({ spanId: 'bbbb', parentSpanId: 'aaaa' }),
        span({ spanId: 'cccc', parentSpanId: 'bbbb' }),
      ],
      [
        evalResult('cccc'),
        evalResult('cccc', { evalId: 'eval-2', passed: false, scoreValue: 0.2 }),
        evalResult('missing-span'),
      ],
    );

    const leaf = tree.byId.get('cccc')!;
    expect(leaf.evals).toHaveLength(2);
    expect(leaf.rollup.evalCount).toBe(2);
    expect(leaf.rollup.evalFailCount).toBe(1);
    expect(tree.byId.get('aaaa')!.rollup.evalCount).toBe(2);
    expect(tree.byId.get('aaaa')!.rollup.evalFailCount).toBe(1);
    expect(tree.byId.get('aaaa')!.evals).toHaveLength(0);
  });

  it('survives a deep chain without stack overflow', () => {
    const spans: TraceSpan[] = [span({ spanId: 'root0000' })];
    let parent = 'root0000';
    for (let i = 1; i <= 5000; i++) {
      const id = `s${i.toString().padStart(7, '0')}`;
      spans.push(span({ spanId: id, parentSpanId: parent, startOffsetNs: i }));
      parent = id;
    }

    const tree = buildSpanTree(spans);
    expect(tree.nodeCount).toBe(5001);
    expect(tree.byId.get(parent)!.depth).toBe(5000);
    expect(tree.roots[0]!.rollup.spanCount).toBe(5001);
    expect(flattenVisible(tree, new Set())).toHaveLength(5001);
  });

  it('returns an empty tree for no spans', () => {
    const tree = buildSpanTree([]);
    expect(tree.roots).toEqual([]);
    expect(tree.nodeCount).toBe(0);
    expect(flattenVisible(tree, new Set())).toEqual([]);
  });
});

describe('flattenVisible', () => {
  const spans = [
    span({ spanId: 'aaaa', startOffsetNs: 0 }),
    span({ spanId: 'bbbb', parentSpanId: 'aaaa', startOffsetNs: 10 }),
    span({ spanId: 'cccc', parentSpanId: 'bbbb', startOffsetNs: 20 }),
    span({ spanId: 'dddd', parentSpanId: 'aaaa', startOffsetNs: 30 }),
    span({ spanId: 'eeee', startOffsetNs: 40 }),
  ];

  it('yields DFS pre-order when nothing is collapsed', () => {
    const tree = buildSpanTree(spans);
    expect(flattenVisible(tree, new Set()).map((n) => n.span.spanId)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
      'dddd',
      'eeee',
    ]);
  });

  it('hides the subtree of a collapsed node but not the node itself', () => {
    const tree = buildSpanTree(spans);
    expect(flattenVisible(tree, new Set(['bbbb'])).map((n) => n.span.spanId)).toEqual([
      'aaaa',
      'bbbb',
      'dddd',
      'eeee',
    ]);
    expect(flattenVisible(tree, new Set(['aaaa'])).map((n) => n.span.spanId)).toEqual([
      'aaaa',
      'eeee',
    ]);
  });
});

describe('categorize', () => {
  it('classifies llm, tool, agent and generic spans', () => {
    expect(categorize(span({ spanId: 'a', operationName: 'chat' }))).toBe('llm');
    expect(categorize(span({ spanId: 'b', operationName: 'embeddings' }))).toBe('llm');
    expect(categorize(span({ spanId: 'c', requestModel: 'gpt-4o' }))).toBe('llm');
    expect(categorize(span({ spanId: 'd', operationName: 'execute_tool' }))).toBe('tool');
    expect(categorize(span({ spanId: 'e', toolName: 'web.search' }))).toBe('tool');
    expect(categorize(span({ spanId: 'f', operationName: 'invoke_agent' }))).toBe('agent');
    expect(categorize(span({ spanId: 'g' }))).toBe('generic');
    // A tool span that also carries a model stays a tool span.
    expect(
      categorize(span({ spanId: 'h', operationName: 'execute_tool', requestModel: 'gpt-4o' })),
    ).toBe('tool');
  });
});

describe('buildSpanTree with pendingParents (live mode)', () => {
  it('synthesizes ONE pending placeholder root for a missing parent', () => {
    const tree = buildSpanTree(
      [
        // Children complete (and arrive) before their parent 'pppp'.
        span({ spanId: 'bbbb', parentSpanId: 'pppp', startOffsetNs: 500 }),
        span({ spanId: 'aaaa', parentSpanId: 'pppp', startOffsetNs: 200 }),
      ],
      [],
      { pendingParents: true },
    );

    expect(tree.pendingCount).toBe(1);
    expect(tree.orphanCount).toBe(0);
    expect(tree.roots).toHaveLength(1);
    const placeholder = tree.roots[0]!;
    expect(placeholder.pending).toBe(true);
    expect(placeholder.span.spanId).toBe('pppp');
    // Starts where its earliest child starts; zero own duration.
    expect(placeholder.span.startOffsetNs).toBe(200);
    expect(placeholder.span.durationNs).toBe(0);
    expect(placeholder.children.map((n) => n.span.spanId)).toEqual(['aaaa', 'bbbb']);
    expect(placeholder.children.every((n) => !n.orphaned)).toBe(true);
  });

  it('rolls children up into the placeholder (duration excluded)', () => {
    const tree = buildSpanTree(
      [
        span({
          spanId: 'aaaa',
          parentSpanId: 'pppp',
          totalTokens: 100,
          costUsd: 0.01,
          durationNs: 5_000,
        }),
        span({ spanId: 'bbbb', parentSpanId: 'pppp', statusCode: 'ERROR', durationNs: 2_000 }),
      ],
      [],
      { pendingParents: true },
    );
    const placeholder = tree.byId.get('pppp')!;
    expect(placeholder.rollup.spanCount).toBe(3);
    expect(placeholder.rollup.errorCount).toBe(1);
    expect(placeholder.rollup.totalTokens).toBe(100);
    expect(placeholder.rollup.costUsd).toBeCloseTo(0.01);
    expect(placeholder.rollup.durationNs).toBe(7_000); // children only
  });

  it('is replaced in place when the real parent arrives (same span id)', () => {
    const child = span({ spanId: 'aaaa', parentSpanId: 'pppp', startOffsetNs: 200 });
    const live = buildSpanTree([child], [], { pendingParents: true });
    expect(live.byId.get('pppp')!.pending).toBe(true);

    const arrived = buildSpanTree(
      [child, span({ spanId: 'pppp', name: 'researcher', startOffsetNs: 0, durationNs: 9_000 })],
      [],
      { pendingParents: true },
    );
    const root = arrived.byId.get('pppp')!;
    expect(root.pending).toBe(false);
    expect(root.span.name).toBe('researcher');
    expect(arrived.pendingCount).toBe(0);
    expect(root.children.map((n) => n.span.spanId)).toEqual(['aaaa']);
  });

  it('builds a deep partial tree: pending ancestors stack as they resolve', () => {
    // A grandchild arrives first; its parent AND grandparent are still open.
    // Only the DIRECT missing parent can be synthesized (the grandparent is
    // not referenced by any arrived span), so the placeholder roots the tree.
    const tree = buildSpanTree(
      [
        span({ spanId: 'cccc', parentSpanId: 'bbbb', startOffsetNs: 900 }),
        span({ spanId: 'dddd', parentSpanId: 'cccc', startOffsetNs: 950 }),
      ],
      [],
      { pendingParents: true },
    );
    expect(tree.pendingCount).toBe(1);
    const placeholder = tree.byId.get('bbbb')!;
    expect(placeholder.pending).toBe(true);
    expect(placeholder.children[0]!.span.spanId).toBe('cccc');
    expect(placeholder.children[0]!.children[0]!.span.spanId).toBe('dddd');
    expect(tree.byId.get('dddd')!.depth).toBe(2);
  });

  it('keeps self-references orphaned rather than synthesizing themselves', () => {
    const tree = buildSpanTree([span({ spanId: 'aaaa', parentSpanId: 'aaaa' })], [], {
      pendingParents: true,
    });
    expect(tree.pendingCount).toBe(0);
    expect(tree.byId.get('aaaa')!.orphaned).toBe(true);
  });

  it('default mode is unchanged: missing parents still orphan their children', () => {
    const tree = buildSpanTree([span({ spanId: 'aaaa', parentSpanId: 'pppp' })]);
    expect(tree.pendingCount).toBe(0);
    expect(tree.orphanCount).toBe(1);
    expect(tree.byId.has('pppp')).toBe(false);
  });

  it('placeholders categorize as generic and never read as retry/error', () => {
    const tree = buildSpanTree(
      [span({ spanId: 'aaaa', parentSpanId: 'pppp', statusCode: 'ERROR', retryAttempt: 3 })],
      [],
      { pendingParents: true },
    );
    const placeholder = tree.byId.get('pppp')!;
    expect(placeholder.category).toBe('generic');
    expect(placeholder.hasError).toBe(false);
    expect(placeholder.isRetry).toBe(false);
  });
});
