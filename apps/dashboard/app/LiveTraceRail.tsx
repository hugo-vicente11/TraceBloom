'use client';

/**
 * "Live now" rail above the trace table: polls /api/traces/live while the
 * tab is visible and lists currently-running traces with a pulsing
 * indicator. When a trace leaves the live set (its root landed) the server
 * page is refreshed once so it appears in the table below without a manual
 * reload. Renders nothing when no trace is running.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatCost } from '../lib/format';
import type { LiveTraceRow } from '../lib/live-list';

const POLL_MS = 3_000;

function formatElapsed(startTime: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startTime)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, '0')}s`;
}

export function LiveTraceRail() {
  const [traces, setTraces] = useState<LiveTraceRow[]>([]);
  const router = useRouter();
  const knownIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight: AbortController | undefined;
    let stopped = false;

    const poll = async () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        const response = await fetch('/api/traces/live', { signal: controller.signal });
        if (!response.ok) {
          return; // keep the previous list; retry next tick
        }
        const payload = (await response.json()) as { traces?: LiveTraceRow[] };
        const next = payload.traces ?? [];
        if (stopped) {
          return;
        }
        setTraces(next);

        // A trace that left the live set just completed: refresh the server
        // page once so it shows up in the table below.
        const nextIds = new Set(next.map((trace) => trace.traceId));
        let someoneFinished = false;
        for (const id of knownIds.current) {
          if (!nextIds.has(id)) {
            someoneFinished = true;
            break;
          }
        }
        knownIds.current = nextIds;
        if (someoneFinished) {
          router.refresh();
        }
      } catch {
        // Aborted or network hiccup: keep the previous list; retry next tick.
      }
    };

    const start = () => {
      if (timer === undefined) {
        void poll();
        timer = setInterval(() => void poll(), POLL_MS);
      }
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      inFlight?.abort();
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [router]);

  if (traces.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Currently running traces"
      className="mb-4 rounded-lg border border-sky-200 bg-sky-50/60 px-4 py-3 shadow-sm"
    >
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-sky-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden />
        Live now · {traces.length}
      </h2>
      <ul className="mt-2 divide-y divide-sky-100">
        {traces.map((trace) => (
          <li key={trace.traceId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5">
            <Link
              href={`/traces/${trace.traceId}`}
              title={`Open ${trace.traceId} and watch it live`}
              className="font-mono text-xs text-sky-800 underline-offset-2 hover:underline"
            >
              {trace.traceId.slice(0, 16)}…
            </Link>
            <span className="text-xs text-slate-600">
              {trace.service || 'unknown service'}
              {trace.model ? ` · ${trace.model}` : ''}
            </span>
            <span className="text-xs tabular-nums text-slate-500">
              {trace.spanCount} span{trace.spanCount === 1 ? '' : 's'}
            </span>
            <span className="text-xs tabular-nums text-slate-500">
              {trace.totalTokens.toLocaleString()} tok
            </span>
            <span className="text-xs tabular-nums text-slate-500">{formatCost(trace.costUsd)}</span>
            {trace.errorCount > 0 ? (
              <span className="rounded bg-rose-100 px-1.5 py-px text-[10px] font-medium text-rose-700">
                {trace.errorCount} error{trace.errorCount > 1 ? 's' : ''}
              </span>
            ) : null}
            <span className="ml-auto text-xs tabular-nums text-slate-400">
              running {formatElapsed(trace.startTime)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
