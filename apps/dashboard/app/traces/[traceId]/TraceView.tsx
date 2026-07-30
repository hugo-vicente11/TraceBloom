'use client';

/**
 * Client shell of the trace page: owns the live subscription (useLiveTrace)
 * and the ticking clock, and renders the header + viewer from the live view
 * so summary stats (duration, spans, tokens, cost) update as deltas arrive.
 * For a completed trace this renders the server snapshot with zero live
 * machinery: the M3 path unchanged.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCost, formatDurationNs } from '../../../lib/format';
import type { TraceDetail, TraceSpan, TraceSummary } from '../../../lib/traces';
import { TraceViewer } from './TraceViewer';
import { type LiveStatus, useLiveTrace, useNowOffsetNs } from './useLiveTrace';

/** Replay pacing: arrival gaps are compressed to roughly this total. */
const REPLAY_TOTAL_MS = 6_000;
const REPLAY_MIN_STEP_MS = 60;
const REPLAY_MAX_STEP_MS = 1_200;

interface Replay {
  active: boolean;
  /** Spans revealed so far, in original ClickHouse-arrival order. */
  revealed: TraceSpan[];
  /** True once every span is revealed (eval chips come back at this point). */
  done: boolean;
  label: string;
  toggle: () => void;
}

/**
 * Replay a COMPLETED trace's original span-arrival order (ingestedMs) at a
 * compressed timescale, feeding the same live rendering path, children
 * that arrived before their parent re-materialize the pending placeholders.
 * Purely client-side: no queries, no stream.
 */
function useReplay(spans: TraceSpan[], enabled: boolean): Replay {
  const [state, setState] = useState({ active: false, count: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const order = useMemo(
    () =>
      [...spans].sort((a, b) => a.ingestedMs - b.ingestedMs || a.startOffsetNs - b.startOffsetNs),
    [spans],
  );

  // Per-step delays: real arrival gaps scaled to ~REPLAY_TOTAL_MS, clamped so
  // bursts stay perceptible and stalls don't drag (batch flushes arrive in
  // bursts: that texture is the point of the replay).
  const delays = useMemo(() => {
    const gaps = order.map((span, i) => {
      const previous = order[i - 1];
      return previous ? Math.max(span.ingestedMs - previous.ingestedMs, 0) : 0;
    });
    const total = gaps.reduce((sum, gap) => sum + gap, 0);
    const scale = total > 0 ? REPLAY_TOTAL_MS / total : 0;
    return gaps.map((gap, i) =>
      i === 0 ? 0 : Math.min(Math.max(gap * scale, REPLAY_MIN_STEP_MS), REPLAY_MAX_STEP_MS),
    );
  }, [order]);

  const clear = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const stop = useCallback(() => {
    clear();
    setState({ active: false, count: 0 });
  }, [clear]);

  const toggle = useCallback(() => {
    if (state.active) {
      stop();
      return;
    }
    setState({ active: true, count: 0 });
    const step = (index: number) => {
      setState({ active: true, count: index + 1 });
      const nextDelay = delays[index + 1];
      if (nextDelay !== undefined) {
        timer.current = setTimeout(() => step(index + 1), nextDelay);
      }
    };
    step(0);
  }, [state.active, stop, delays]);

  // No leaked timers on unmount. (The span set of a completed trace is
  // static, so a mid-replay change of `order` cannot occur.)
  useEffect(() => clear, [clear]);

  if (!enabled || order.length === 0) {
    return { active: false, revealed: spans, done: true, label: '', toggle };
  }
  return {
    active: state.active,
    revealed: state.active ? order.slice(0, state.count) : spans,
    done: !state.active || state.count >= order.length,
    label: state.active ? `■ Stop replay · ${state.count}/${order.length}` : '▶ Replay arrival',
    toggle,
  };
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums text-slate-700">{value}</dd>
    </div>
  );
}

/** Completed traces get the OK/errors chip; running ones the LIVE states. */
function StatusBadge({
  running,
  status,
  errorCount,
}: {
  running: boolean;
  status: LiveStatus;
  errorCount: number;
}) {
  if (!running) {
    return (
      <span className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            errorCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
          }`}
        >
          {errorCount > 0 ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : 'OK'}
        </span>
        {status === 'live' || status === 'connecting' ? (
          <span className="text-xs text-slate-400" title="The async evaluator may still add scores">
            listening for eval scores…
          </span>
        ) : null}
      </span>
    );
  }

  const meta: Record<LiveStatus, { classes: string; label: string; pulse: boolean }> = {
    static: { classes: 'bg-sky-100 text-sky-700', label: 'LIVE', pulse: true },
    connecting: { classes: 'bg-sky-100 text-sky-700', label: 'LIVE · connecting…', pulse: true },
    live: { classes: 'bg-sky-100 text-sky-700', label: 'LIVE', pulse: true },
    reconnecting: {
      classes: 'bg-amber-100 text-amber-700',
      label: 'LIVE · reconnecting…',
      pulse: false,
    },
    paused: { classes: 'bg-slate-100 text-slate-500', label: 'LIVE · paused', pulse: false },
    ended: { classes: 'bg-slate-100 text-slate-500', label: 'stream ended', pulse: false },
    unavailable: {
      classes: 'bg-amber-100 text-amber-700',
      label: 'live updates unavailable',
      pulse: false,
    },
  };
  const { classes, label, pulse } = meta[status];
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}
      title="This trace is still running: spans appear as they complete"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? 'animate-pulse' : ''}`}
        aria-hidden
      />
      {label}
    </span>
  );
}

function TraceHeader({
  trace,
  running,
  status,
  nowOffsetNs,
  replay,
}: {
  trace: TraceSummary;
  running: boolean;
  status: LiveStatus;
  nowOffsetNs: number;
  replay?: Replay;
}) {
  return (
    <header className="mb-5">
      <div className="flex items-center justify-between">
        <Link href="/traces" className="text-sm text-slate-500 hover:underline">
          ← Traces
        </Link>
        <Link href="/evals" className="text-sm text-slate-500 hover:underline">
          Evals →
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg tracking-tight text-slate-800">{trace.traceId}</h1>
        <StatusBadge running={running} status={status} errorCount={trace.errorCount} />
        {replay && replay.label ? (
          <button
            type="button"
            onClick={replay.toggle}
            title="Animate the spans in their original arrival order"
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
              replay.active
                ? 'border-sky-300 bg-sky-100 text-sky-700'
                : 'border-slate-300 text-slate-600 hover:bg-slate-100'
            }`}
          >
            {replay.label}
          </button>
        ) : null}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
        <Stat label="Started (UTC)" value={trace.startTime.replace('T', ' ').replace('Z', '')} />
        <Stat
          label={running ? 'Elapsed' : 'Duration'}
          value={formatDurationNs(running ? nowOffsetNs : trace.durationNs)}
          title={running ? 'Ticking until the root span completes' : undefined}
        />
        <Stat label="Spans" value={trace.spanCount.toLocaleString()} />
        <Stat
          label="Tokens (in/out)"
          value={`${trace.totalTokens.toLocaleString()} (${trace.inputTokens.toLocaleString()}/${trace.outputTokens.toLocaleString()})`}
        />
        <Stat label="Cost" value={formatCost(trace.costUsd)} />
        <Stat label="Service" value={trace.serviceNames.join(', ') || '—'} />
        <Stat label="Models" value={trace.models.join(', ') || '—'} />
      </dl>
    </header>
  );
}

export function TraceView({
  detail,
  initialSpanId,
}: {
  detail: TraceDetail;
  initialSpanId?: string;
}) {
  const { view, status } = useLiveTrace(detail);
  const nowOffsetNs = useNowOffsetNs(view.running, view.anchorStartNs, view.trace.durationNs);
  const replay = useReplay(view.spans, !view.running);

  // During a replay the viewer runs through the live path with a synthetic
  // "now": the frontier of what has been revealed so far. Eval chips return
  // once the replay completes (they arrived after the spans in reality too).
  const replayFrontierNs = useMemo(() => {
    if (!replay.active) {
      return 0;
    }
    let frontier = 1;
    for (const span of replay.revealed) {
      frontier = Math.max(frontier, span.startOffsetNs + span.durationNs);
    }
    return frontier;
  }, [replay.active, replay.revealed]);

  const spans = replay.active ? replay.revealed : view.spans;
  const evalResults = replay.active && !replay.done ? [] : view.evalResults;
  const live = view.running
    ? { running: true as const, nowOffsetNs }
    : replay.active && !replay.done
      ? { running: true as const, nowOffsetNs: replayFrontierNs }
      : undefined;

  return (
    <>
      <TraceHeader
        trace={view.trace}
        running={view.running}
        status={status}
        nowOffsetNs={nowOffsetNs}
        replay={view.running ? undefined : replay}
      />
      <TraceViewer
        trace={view.trace}
        spans={spans}
        evalResults={evalResults}
        truncated={detail.truncated}
        initialSpanId={initialSpanId}
        live={live}
      />
    </>
  );
}
