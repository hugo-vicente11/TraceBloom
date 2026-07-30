'use client';

/**
 * The trace viewer: collapsible span tree aligned with a waterfall timeline.
 * Rows and bars are plain CSS grid + positioned divs, no charting library.
 * The tree is rebuilt client-side with useMemo from the flat (lean) payload;
 * expand/collapse state is just a Set of collapsed span ids over which the
 * visible rows are re-flattened.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCost, formatDurationNs, formatTokens } from '../../../lib/format';
import {
  buildSpanTree,
  flattenVisible,
  type SpanNode,
  type SpanTree,
} from '../../../lib/trace-tree';
import type { SpanEvalResult, TraceSpan, TraceSummary } from '../../../lib/traces';
import { SpanDetailPanel } from './SpanDetailPanel';
import { CATEGORY_META, CategoryIcon, ERROR_COLOR, RUNNING_COLOR } from './theme';

const ROW_HEIGHT = 28;
const INDENT_PX = 14;
// Shared by the header and every row so the tree and waterfall stay aligned.
const GRID_TEMPLATE = 'minmax(300px,1.25fr) 110px 90px 90px 90px minmax(260px,1fr)';

/** Present while the trace is still running (live mode). */
export interface LiveViewerState {
  running: true;
  /** Ticking "now", as ns since the trace anchor — grows in-progress bars. */
  nowOffsetNs: number;
}

export interface TraceViewerProps {
  trace: TraceSummary;
  spans: TraceSpan[];
  evalResults: SpanEvalResult[];
  truncated: boolean;
  initialSpanId?: string;
  /** Omitted for completed traces: rendering is then exactly the M3 path. */
  live?: LiveViewerState;
}

function EvalChips({ evals }: { evals: SpanEvalResult[] }) {
  if (evals.length === 0) {
    return null;
  }
  const shown = evals.slice(0, 2);
  return (
    <span className="flex items-center gap-1">
      {shown.map((ev) => {
        const errored = ev.errorType !== '';
        const classes = errored
          ? 'bg-amber-100 text-amber-700'
          : ev.passed
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-rose-100 text-rose-700';
        const glyph = errored ? '!' : ev.passed ? '✓' : '✗';
        const tooltip = `${ev.evaluationName}: ${errored ? ev.errorType : ev.scoreValue.toFixed(2)}${
          ev.explanation ? ` — ${ev.explanation}` : ''
        }`;
        return (
          <span
            key={ev.evalId}
            title={tooltip}
            className={`rounded px-1 py-px font-mono text-[10px] leading-4 ${classes}`}
          >
            {glyph} {errored ? 'eval' : ev.scoreValue.toFixed(2)}
          </span>
        );
      })}
      {evals.length > shown.length ? (
        <span className="text-[10px] text-slate-400">+{evals.length - shown.length}</span>
      ) : null}
    </span>
  );
}

/** Vertical hairlines at the quartiles, behind the bars. */
function Gridlines() {
  return (
    <>
      {[25, 50, 75].map((pct) => (
        <span
          key={pct}
          className="absolute inset-y-0 w-px bg-slate-100"
          style={{ left: `${pct}%` }}
          aria-hidden
        />
      ))}
    </>
  );
}

interface RowProps {
  node: SpanNode;
  totalNs: number;
  /** Ticking now-offset while the trace runs; 0 for completed traces. */
  nowNs: number;
  selected: boolean;
  isCollapsed: boolean;
  onToggle: (spanId: string) => void;
  onSelect: (spanId: string) => void;
}

const SpanRow = memo(function SpanRow({
  node,
  totalNs,
  nowNs,
  selected,
  isCollapsed,
  onToggle,
  onSelect,
}: RowProps) {
  const { span } = node;
  const hasChildren = node.children.length > 0;
  const color = node.pending
    ? RUNNING_COLOR
    : node.hasError
      ? ERROR_COLOR
      : CATEGORY_META[node.category].color;
  const leftPct = Math.min((span.startOffsetNs / totalNs) * 100, 99.6);
  // A pending span has no duration yet: its bar grows from its earliest
  // child's start to "now" until the real span arrives and replaces it.
  const barNs = node.pending ? Math.max(nowNs - span.startOffsetNs, 0) : span.durationNs;
  const widthPct = (barNs / totalNs) * 100;
  const descendantErrors = node.rollup.errorCount - (node.hasError ? 1 : 0);
  // Parents show subtree totals (dimmed, Σ) so cost/usage roll up the tree.
  const tokens = hasChildren ? node.rollup.totalTokens : span.totalTokens;
  const cost = hasChildren ? node.rollup.costUsd : span.costUsd;
  const model = span.requestModel || span.responseModel;

  const barTitle = node.pending
    ? `still running — ${formatDurationNs(barNs)} elapsed @ +${formatDurationNs(span.startOffsetNs)}`
    : `${span.name} — ${formatDurationNs(span.durationNs)} @ +${formatDurationNs(
        span.startOffsetNs,
      )}${node.hasError ? ` — ERROR${span.statusMessage ? `: ${span.statusMessage}` : ''}` : ''}`;

  return (
    <div
      // A virtualized interactive hierarchy has no native element; the ARIA
      // tree pattern (treeitem + aria-level/expanded) is the semantic fit.
      role="treeitem"
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      aria-selected={selected}
      aria-busy={node.pending || undefined}
      tabIndex={0}
      // A pending placeholder has no landed span row to open in the panel.
      onClick={node.pending ? undefined : () => onSelect(span.spanId)}
      onKeyDown={(event) => {
        if (!node.pending && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(span.spanId);
        }
      }}
      id={`span-row-${span.spanId}`}
      className={`grid items-center border-b border-slate-100 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
        node.pending ? 'cursor-default' : 'cursor-pointer'
      } ${selected ? 'bg-blue-50/80 hover:bg-blue-50' : 'hover:bg-slate-50'}`}
      style={{ gridTemplateColumns: GRID_TEMPLATE, height: ROW_HEIGHT }}
    >
      {/* Tree cell */}
      <div className="flex min-w-0 items-center gap-1.5 pr-2">
        <span style={{ width: node.depth * INDENT_PX }} className="shrink-0" aria-hidden />
        {hasChildren ? (
          <button
            type="button"
            title={isCollapsed ? 'Expand subtree' : 'Collapse subtree'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(span.spanId);
            }}
            className={`flex h-4 w-4 shrink-0 items-center justify-center text-[9px] text-slate-400 transition-transform hover:text-slate-700 ${
              isCollapsed ? '' : 'rotate-90'
            }`}
          >
            ▶
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <CategoryIcon category={node.category} />
        {node.pending ? (
          <span className="truncate italic text-sky-700" title="Span still running">
            running…
          </span>
        ) : (
          <span
            className={`truncate ${node.hasError ? 'font-medium text-rose-700' : 'text-slate-700'}`}
            title={span.name}
          >
            {span.name}
          </span>
        )}
        {node.pending ? (
          <span
            className="animate-pulse rounded bg-sky-100 px-1 py-px text-[10px] font-medium leading-4 text-sky-700"
            title="Waiting for this span to complete; children attach as they arrive."
          >
            running
          </span>
        ) : null}
        {node.hasError ? (
          <span
            className="rounded bg-rose-100 px-1 py-px text-[10px] font-medium leading-4 text-rose-700"
            title={span.statusMessage || 'Span ended with status ERROR'}
          >
            error
          </span>
        ) : null}
        {node.isRetry ? (
          <span
            className="rounded bg-amber-100 px-1 py-px text-[10px] font-medium leading-4 text-amber-700"
            title={`Retry — attempt ${span.retryAttempt}`}
          >
            ↻ ×{span.retryAttempt}
          </span>
        ) : null}
        {node.orphaned ? (
          <span
            className="rounded border border-slate-300 px-1 py-px text-[10px] leading-4 text-slate-500"
            title="Parent span is missing from this trace (late or dropped); shown at the root."
          >
            orphan
          </span>
        ) : null}
        {descendantErrors > 0 ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: ERROR_COLOR }}
            title={`${descendantErrors} error span${descendantErrors > 1 ? 's' : ''} in subtree`}
          />
        ) : null}
        <EvalChips evals={node.evals} />
        {isCollapsed && hasChildren ? (
          <span className="whitespace-nowrap text-[10px] text-slate-400">
            +{node.rollup.spanCount - 1}
          </span>
        ) : null}
      </div>

      {/* Model */}
      <div className="truncate pr-2 text-xs text-slate-500" title={model}>
        {model || '—'}
      </div>

      {/* Tokens */}
      <div
        className={`pr-3 text-right tabular-nums ${hasChildren ? 'text-xs text-slate-400' : 'text-xs text-slate-600'}`}
        title={
          hasChildren
            ? `Subtree: ${node.rollup.inputTokens.toLocaleString()} in / ${node.rollup.outputTokens.toLocaleString()} out`
            : `${span.inputTokens.toLocaleString()} in / ${span.outputTokens.toLocaleString()} out`
        }
      >
        {tokens > 0 ? `${hasChildren ? 'Σ ' : ''}${formatTokens(tokens)}` : '—'}
      </div>

      {/* Cost */}
      <div
        className={`pr-3 text-right tabular-nums ${hasChildren ? 'text-xs text-slate-400' : 'text-xs text-slate-600'}`}
        title={hasChildren ? 'Subtree cost' : undefined}
      >
        {cost > 0 ? `${hasChildren ? 'Σ ' : ''}${formatCost(cost)}` : '—'}
      </div>

      {/* Duration (own wall-clock; subtree compute time in the tooltip) */}
      <div
        className={`pr-3 text-right text-xs tabular-nums ${
          node.pending ? 'animate-pulse text-sky-600' : 'text-slate-600'
        }`}
        title={
          node.pending
            ? 'Elapsed so far (still running)'
            : hasChildren
              ? `Subtree compute time: ${formatDurationNs(node.rollup.durationNs)}`
              : undefined
        }
      >
        {formatDurationNs(barNs)}
      </div>

      {/* Waterfall cell */}
      <div className="relative h-full overflow-hidden border-l border-slate-100">
        <Gridlines />
        <span
          className={`absolute top-1/2 block h-3.5 -translate-y-1/2 rounded-[3px] ${
            node.pending ? 'animate-pulse' : ''
          }`}
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            // Instant spans must stay visible; min-width beats width in CSS.
            minWidth: 3,
            maxWidth: `${100 - leftPct}%`,
            backgroundColor: color,
          }}
          title={barTitle}
        />
      </div>
    </div>
  );
});

/** Time axis across the waterfall column: quartile ticks + total. */
function TimeAxis({ totalNs }: { totalNs: number }) {
  return (
    <div className="relative h-full border-l border-slate-100">
      {[0, 25, 50, 75].map((pct) => (
        <span
          key={pct}
          className="absolute top-1/2 -translate-y-1/2 pl-1 text-[10px] tabular-nums text-slate-400"
          style={{ left: `${pct}%` }}
        >
          {formatDurationNs((totalNs * pct) / 100)}
        </span>
      ))}
      <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-slate-400">
        {formatDurationNs(totalNs)}
      </span>
    </div>
  );
}

function Legend({ live }: { live: boolean }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-slate-500">
      {(Object.keys(CATEGORY_META) as (keyof typeof CATEGORY_META)[]).map((category) => (
        <span key={category} className="flex items-center gap-1">
          <CategoryIcon category={category} size={11} />
          {CATEGORY_META[category].label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: ERROR_COLOR }} />
        Error
      </span>
      {live ? (
        <span className="flex items-center gap-1">
          <span
            className="h-2 w-2 animate-pulse rounded-sm"
            style={{ backgroundColor: RUNNING_COLOR }}
          />
          Running
        </span>
      ) : null}
    </div>
  );
}

function collapsibleIds(tree: SpanTree): Set<string> {
  const ids = new Set<string>();
  for (const [id, node] of tree.byId) {
    if (node.children.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

// Rows above/below the viewport that stay mounted, so fast scrolling doesn't
// flash blank rows before the next render.
const OVERSCAN_ROWS = 12;
// jsdom (rendering smoke tests) reports clientHeight 0; fall back to a real
// viewport so tests exercise the same windowed path browsers use.
const FALLBACK_VIEWPORT_PX = 800;

/**
 * Hand-rolled fixed-row-height windowing. The visible rows are already a flat
 * array and every row is exactly ROW_HEIGHT tall, so the window is pure
 * arithmetic on scrollTop: a virtualization library would add a dependency
 * for ~40 lines of code. Scroll updates are rAF-coalesced so a 1k+ span trace
 * scrolls at frame rate rendering only ~40 rows.
 */
function useRowWindow(rowCount: number) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT_PX);
  const frame = useRef(0);

  const onScroll = useCallback(() => {
    if (frame.current !== 0) {
      return;
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = viewportRef.current;
      if (el) {
        setScrollTop(el.scrollTop);
      }
    });
  }, []);

  useEffect(() => {
    const measure = () => {
      const el = viewportRef.current;
      setViewportH(el?.clientHeight || FALLBACK_VIEWPORT_PX);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      if (frame.current !== 0) {
        cancelAnimationFrame(frame.current);
      }
    };
  }, []);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN_ROWS,
  );

  const scrollToIndex = useCallback((index: number) => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }
    const height = el.clientHeight || FALLBACK_VIEWPORT_PX;
    el.scrollTop = Math.max(0, index * ROW_HEIGHT - height / 2 + ROW_HEIGHT / 2);
    setScrollTop(el.scrollTop);
  }, []);

  return { viewportRef, onScroll, startIndex, endIndex, scrollToIndex };
}

export function TraceViewer({
  trace,
  spans,
  evalResults,
  truncated,
  initialSpanId,
  live,
}: TraceViewerProps) {
  const running = live?.running ?? false;
  const tree = useMemo(
    () => buildSpanTree(spans, evalResults, { pendingParents: running }),
    [spans, evalResults, running],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSpanId);
  // While running, the timeline's right edge is "now" so in-progress bars
  // have room to grow; it never shrinks below the last known span end.
  const nowNs = live?.nowOffsetNs ?? 0;
  const totalNs = Math.max(trace.durationNs, running ? nowNs : 0, 1);

  const onToggle = useCallback((spanId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  }, []);

  const evalsBySpan = useMemo(() => {
    const map = new Map<string, SpanEvalResult[]>();
    for (const result of evalResults) {
      const list = map.get(result.spanId);
      if (list) {
        list.push(result);
      } else {
        map.set(result.spanId, [result]);
      }
    }
    return map;
  }, [evalResults]);

  const onSelect = useCallback((spanId: string) => {
    setSelectedId(spanId);
    // Keep the span in the URL so trace views are shareable/deep-linkable
    // without a navigation.
    const url = new URL(window.location.href);
    url.searchParams.set('span', spanId);
    window.history.replaceState(null, '', url);
  }, []);

  const onClosePanel = useCallback(() => {
    setSelectedId(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete('span');
    window.history.replaceState(null, '', url);
  }, []);

  const { viewportRef, onScroll, startIndex, endIndex, scrollToIndex } = useRowWindow(rows.length);

  // Deep link: scroll the preselected span's row into the window once. Rows
  // may not be mounted (virtualization), so this is scroll math, not DOM
  // lookup.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current || !initialSpanId) {
      return;
    }
    didInitialScroll.current = true;
    const index = rows.findIndex((node) => node.span.spanId === initialSpanId);
    if (index >= 0) {
      scrollToIndex(index);
    }
  }, [initialSpanId, rows, scrollToIndex]);

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <button
              type="button"
              onClick={() => setCollapsed(new Set())}
              className="font-medium text-slate-600 hover:underline"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(collapsibleIds(tree))}
              className="font-medium text-slate-600 hover:underline"
            >
              Collapse all
            </button>
            <span className="tabular-nums">
              {(tree.nodeCount - tree.pendingCount).toLocaleString()} spans
              {tree.pendingCount > 0 ? ` · ${tree.pendingCount} running` : ''}
              {tree.orphanCount > 0 ? ` · ${tree.orphanCount} orphaned` : ''}
            </span>
            {truncated ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">
                showing first {spans.length.toLocaleString()} spans
              </span>
            ) : null}
          </div>
          <Legend live={running} />
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            {/* Column header (sticky within the vertical scroll region below) */}
            <div
              className="grid border-b border-slate-200 bg-slate-50 text-[10px] font-medium uppercase tracking-wide text-slate-400"
              style={{ gridTemplateColumns: GRID_TEMPLATE, height: 26 }}
            >
              <div className="flex items-center pl-2">Span</div>
              <div className="flex items-center">Model</div>
              <div className="flex items-center justify-end pr-3">Tokens</div>
              <div className="flex items-center justify-end pr-3">Cost</div>
              <div className="flex items-center justify-end pr-3">Duration</div>
              <TimeAxis totalNs={totalNs} />
            </div>

            <div
              ref={viewportRef}
              onScroll={onScroll}
              role="tree"
              aria-label="Trace spans"
              className="max-h-[70vh] overflow-y-auto"
            >
              {/* Spacer keeps the scrollbar honest; only the window is mounted. */}
              <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
                <div className="absolute inset-x-0" style={{ top: startIndex * ROW_HEIGHT }}>
                  {rows.slice(startIndex, endIndex).map((node) => (
                    <SpanRow
                      key={node.span.spanId}
                      node={node}
                      totalNs={totalNs}
                      nowNs={nowNs}
                      selected={node.span.spanId === selectedId}
                      isCollapsed={collapsed.has(node.span.spanId)}
                      onToggle={onToggle}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedId ? (
        <SpanDetailPanel
          key={selectedId}
          traceId={trace.traceId}
          spanId={selectedId}
          evals={evalsBySpan.get(selectedId) ?? []}
          onClose={onClosePanel}
        />
      ) : null}
    </div>
  );
}
