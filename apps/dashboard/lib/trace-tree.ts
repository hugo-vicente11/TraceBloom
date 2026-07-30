/**
 * Span-tree reconstruction for the trace viewer: turns the flat span rows of
 * one trace (OTLP parent/child links) into an ordered tree with subtree
 * roll-ups, tolerating real-world malformed data: missing/late parents,
 * self-references, cycles, duplicate span ids.
 *
 * Pure and side-effect free (no ClickHouse, no React) so it is unit-testable
 * and shared between the server page and the client viewer. Only type-only
 * imports from ./traces, so client bundles never pull in the DB client.
 */

import type { SpanEvalResult, TraceSpan } from './traces';

export type SpanCategory = 'llm' | 'tool' | 'agent' | 'generic';

/** Aggregates over a span and all of its descendants. */
export interface SubtreeRollup {
  /** Number of spans in the subtree, including the span itself. */
  spanCount: number;
  /** Spans with status ERROR in the subtree. */
  errorCount: number;
  /** Spans marked as retries (tracebloom.retry.attempt >= 2). */
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /**
   * Sum of every subtree span's own duration. This is compute time, not wall
   * clock: with parallel children it exceeds the parent span's duration.
   */
  durationNs: number;
  /** Eval results attached to spans in the subtree. */
  evalCount: number;
  /** Of those, how many did not pass (failed or errored evaluations). */
  evalFailCount: number;
}

export interface SpanNode {
  span: TraceSpan;
  children: SpanNode[];
  depth: number;
  category: SpanCategory;
  /**
   * True when the span referenced a parent that is not part of the payload
   * (late/dropped parent span) or closed a parent cycle; it is rendered as a
   * root but visually flagged.
   */
  orphaned: boolean;
  /**
   * True for a synthesized in-progress placeholder (live mode): the span id
   * is referenced as a parent but the span itself has not arrived, it is
   * still open, because OTel exports spans when they END and children finish
   * first. The node is replaced in place once the real span lands.
   */
  pending: boolean;
  hasError: boolean;
  isRetry: boolean;
  rollup: SubtreeRollup;
  /** Eval results attached directly to this span. */
  evals: SpanEvalResult[];
}

export interface SpanTree {
  roots: SpanNode[];
  /** Every node, keyed by span id (deduplicated). */
  byId: Map<string, SpanNode>;
  nodeCount: number;
  orphanCount: number;
  /** Synthesized in-progress placeholders (always 0 without pendingParents). */
  pendingCount: number;
}

export interface BuildOptions {
  /**
   * Live mode (DECISIONS.md D22): synthesize a `pending` placeholder node
   * for every referenced-but-missing parent instead of flagging its children
   * as orphans. While a trace is running, "parent missing" almost always
   * means "parent span still open"; after completion the same situation is a
   * data defect and the default orphan handling applies.
   */
  pendingParents?: boolean;
}

const LLM_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);
const AGENT_OPERATIONS = new Set(['invoke_agent', 'create_agent']);

/** Classify a span by its OTel GenAI operation (tool > agent > llm > generic). */
export function categorize(span: TraceSpan): SpanCategory {
  if (span.operationName === 'execute_tool' || span.toolName !== '') {
    return 'tool';
  }
  if (AGENT_OPERATIONS.has(span.operationName)) {
    return 'agent';
  }
  if (LLM_OPERATIONS.has(span.operationName) || span.requestModel !== '') {
    return 'llm';
  }
  return 'generic';
}

function makeNode(span: TraceSpan): SpanNode {
  const isRetry = span.retryAttempt >= 2;
  const hasError = span.statusCode === 'ERROR';
  return {
    span,
    children: [],
    depth: 0,
    category: categorize(span),
    orphaned: false,
    pending: false,
    hasError,
    isRetry,
    rollup: {
      spanCount: 1,
      errorCount: hasError ? 1 : 0,
      retryCount: isRetry ? 1 : 0,
      inputTokens: span.inputTokens,
      outputTokens: span.outputTokens,
      totalTokens: span.totalTokens,
      costUsd: span.costUsd,
      durationNs: span.durationNs,
      evalCount: 0,
      evalFailCount: 0,
    },
    evals: [],
  };
}

/**
 * Zero-valued span standing in for a still-open parent. Starts where its
 * earliest (already-arrived) child starts; duration 0 so it never skews
 * subtree compute-time roll-ups: the viewer draws its growing bar from a
 * live clock instead.
 */
function makePendingSpan(spanId: string, startOffsetNs: number): TraceSpan {
  return {
    spanId,
    parentSpanId: '',
    name: '',
    kind: '',
    statusCode: 'UNSET',
    statusMessage: '',
    serviceName: '',
    operationName: '',
    provider: '',
    requestModel: '',
    responseModel: '',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    startOffsetNs,
    durationNs: 0,
    toolName: '',
    promptVersion: '',
    retryAttempt: 0,
    ingestedMs: 0,
  };
}

function byStartThenId(a: SpanNode, b: SpanNode): number {
  if (a.span.startOffsetNs !== b.span.startOffsetNs) {
    return a.span.startOffsetNs - b.span.startOffsetNs;
  }
  return a.span.spanId < b.span.spanId ? -1 : a.span.spanId > b.span.spanId ? 1 : 0;
}

/**
 * Build the span tree from flat rows.
 *
 * - Duplicate span ids keep the first occurrence (rows arrive start-ordered).
 * - A span whose parent id is set but absent becomes an `orphaned` root.
 * - Self-references and cycles are cut deterministically: walking each span's
 *   ancestor chain, the first cycle member encountered (earliest by input
 *   order, i.e. by start time) loses its parent link and becomes an orphaned
 *   root, so every span appears in the tree exactly once.
 * - Children (and roots) are ordered by (start offset, span id).
 * - Roll-ups aggregate each subtree (self included) in one reverse pre-order
 *   pass; eval results attach to their span and count into its ancestors.
 * - With `pendingParents`, a referenced-but-missing parent becomes a pending
 *   placeholder ROOT (its own parent is unknowable) holding its children.
 */
export function buildSpanTree(
  spans: readonly TraceSpan[],
  evalResults: readonly SpanEvalResult[] = [],
  options: BuildOptions = {},
): SpanTree {
  const byId = new Map<string, SpanNode>();
  for (const span of spans) {
    if (!byId.has(span.spanId)) {
      byId.set(span.spanId, makeNode(span));
    }
  }

  if (options.pendingParents) {
    // Collect missing parents and the earliest start among their children;
    // synthesizing the placeholders BEFORE parent resolution means the rest
    // of the algorithm (cycles, ordering, roll-ups) needs no special cases.
    const pendingStarts = new Map<string, number>();
    for (const node of byId.values()) {
      const parentId = node.span.parentSpanId;
      if (parentId === '' || parentId === node.span.spanId || byId.has(parentId)) {
        continue;
      }
      const known = pendingStarts.get(parentId);
      pendingStarts.set(
        parentId,
        known === undefined ? node.span.startOffsetNs : Math.min(known, node.span.startOffsetNs),
      );
    }
    for (const [spanId, startOffsetNs] of pendingStarts) {
      const node = makeNode(makePendingSpan(spanId, startOffsetNs));
      node.pending = true;
      byId.set(spanId, node);
    }
  }

  // Resolve each node's effective parent; missing/self parents orphan the node.
  const parentOf = new Map<SpanNode, SpanNode | undefined>();
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    if (parentId === '' || parentId === node.span.spanId) {
      node.orphaned = parentId !== '';
      parentOf.set(node, undefined);
      continue;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      node.orphaned = true;
      parentOf.set(node, undefined);
      continue;
    }
    parentOf.set(node, parent);
  }

  // Cut cycles: walk ancestors until a node already known to reach a root
  // ("safe"); revisiting a node from the current walk means a cycle, and the
  // walk's starting side (earliest in input order) becomes an orphaned root.
  const safe = new Set<SpanNode>();
  for (const start of byId.values()) {
    const path: SpanNode[] = [];
    const onPath = new Set<SpanNode>();
    let current: SpanNode | undefined = start;
    while (current && !safe.has(current)) {
      if (onPath.has(current)) {
        parentOf.set(current, undefined);
        current.orphaned = true;
        break;
      }
      path.push(current);
      onPath.add(current);
      current = parentOf.get(current);
    }
    for (const visited of path) {
      safe.add(visited);
    }
  }

  // Materialize children arrays and roots, deterministically ordered.
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parent = parentOf.get(node);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  roots.sort(byStartThenId);
  for (const node of byId.values()) {
    node.children.sort(byStartThenId);
  }

  // Depths via iterative DFS (a 10k-span chain must not overflow the stack).
  const stack: SpanNode[] = [...roots].reverse();
  const preOrder: SpanNode[] = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      break;
    }
    preOrder.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) {
        child.depth = node.depth + 1;
        stack.push(child);
      }
    }
  }

  // Attach eval results (ignoring ids not in the payload, e.g. beyond the cap).
  for (const result of evalResults) {
    const node = byId.get(result.spanId);
    if (!node) {
      continue;
    }
    node.evals.push(result);
    node.rollup.evalCount += 1;
    if (result.errorType !== '' || !result.passed) {
      node.rollup.evalFailCount += 1;
    }
  }

  // Roll-ups: children precede parents when pre-order is walked in reverse,
  // so one reverse pass folds every child's rollup into its parent.
  for (let i = preOrder.length - 1; i >= 0; i--) {
    const node = preOrder[i];
    if (!node) {
      continue;
    }
    for (const child of node.children) {
      const r = node.rollup;
      const c = child.rollup;
      r.spanCount += c.spanCount;
      r.errorCount += c.errorCount;
      r.retryCount += c.retryCount;
      r.inputTokens += c.inputTokens;
      r.outputTokens += c.outputTokens;
      r.totalTokens += c.totalTokens;
      r.costUsd += c.costUsd;
      r.durationNs += c.durationNs;
      r.evalCount += c.evalCount;
      r.evalFailCount += c.evalFailCount;
    }
  }

  let orphanCount = 0;
  let pendingCount = 0;
  for (const node of byId.values()) {
    if (node.orphaned) {
      orphanCount += 1;
    }
    if (node.pending) {
      pendingCount += 1;
    }
  }

  return { roots, byId, nodeCount: byId.size, orphanCount, pendingCount };
}

/**
 * The rows currently visible given a set of collapsed span ids, in rendering
 * order (DFS pre-order; a collapsed node stays visible, its subtree does not).
 * This flat list is what the virtualized viewer windows over.
 */
export function flattenVisible(tree: SpanTree, collapsed: ReadonlySet<string>): SpanNode[] {
  const out: SpanNode[] = [];
  const stack: SpanNode[] = [...tree.roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      break;
    }
    out.push(node);
    if (!collapsed.has(node.span.spanId)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) {
          stack.push(child);
        }
      }
    }
  }
  return out;
}
