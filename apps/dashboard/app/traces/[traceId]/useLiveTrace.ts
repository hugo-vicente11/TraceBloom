'use client';

/**
 * Client half of the live channel: subscribes to the SSE delta stream and
 * folds deltas into the merged live state (lib/live). Handles the whole
 * connection lifecycle: automatic EventSource reconnects resume via
 * Last-Event-ID; a backgrounded tab closes the stream and resumes from the
 * merged cursor when visible again; unmount closes the stream (the server
 * poller stops when its last subscriber leaves).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyDelta,
  deriveTraceView,
  encodeCursor,
  type LiveDelta,
  type LiveTraceView,
  seedLiveState,
} from '../../../lib/live';
import type { TraceDetail } from '../../../lib/traces';

export type LiveStatus =
  /** Trace was complete at load: no stream, server payload rendered as-is. */
  | 'static'
  | 'connecting'
  | 'live'
  /** Connection dropped; the browser is retrying with Last-Event-ID. */
  | 'reconnecting'
  /** Tab hidden: stream closed, will resume from the cursor when visible. */
  | 'paused'
  /** Server sent the terminal `end` event (trace settled or went dead). */
  | 'ended'
  /** Fatal subscribe failure (e.g. capacity 503): not retrying. */
  | 'unavailable';

export interface UseLiveTraceResult {
  view: LiveTraceView;
  status: LiveStatus;
}

/** Parse a delta payload defensively: a malformed frame is dropped, not fatal. */
function parseDelta(data: string): LiveDelta | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as LiveDelta).spans) &&
      Array.isArray((parsed as LiveDelta).evals)
    ) {
      return parsed as LiveDelta;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Live state for one trace page. For a completed trace this is a pure
 * pass-through of the server snapshot (no stream, no timers). `detail` is
 * the server-rendered payload and never changes for a mounted page.
 */
export function useLiveTrace(detail: TraceDetail): UseLiveTraceResult {
  const [state, setState] = useState(() =>
    seedLiveState({
      traceId: detail.trace.traceId,
      anchorStartNs: detail.anchorStartNs,
      spans: detail.spans,
      evalResults: detail.evalResults,
      cursor: detail.cursor,
      // Live mode implies the root has not arrived (that is what makes the
      // trace "running"); the static path below never reads this state.
      rootSeen: false,
    }),
  );
  const [status, setStatus] = useState<LiveStatus>(detail.running ? 'connecting' : 'static');

  // The resume cursor must be readable from event handlers without retriggering
  // the effect (the subscription must not churn on every delta).
  const stateRef = useRef(state);
  stateRef.current = state;

  const traceId = detail.trace.traceId;
  useEffect(() => {
    if (!detail.running) {
      return;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('unavailable');
      return;
    }

    let source: EventSource | undefined;
    let stopped = false;

    const connect = () => {
      const cursor = encodeCursor(stateRef.current.cursor);
      source = new EventSource(`/api/traces/${traceId}/live?cursor=${cursor}`);
      source.onopen = () => setStatus('live');
      source.onerror = () => {
        if (!source) {
          return;
        }
        // CLOSED means the browser gave up (non-200 such as the capacity
        // 503): surface it. CONNECTING means an automatic retry is underway
        // and Last-Event-ID carries the cursor.
        setStatus(source.readyState === EventSource.CLOSED ? 'unavailable' : 'reconnecting');
      };
      source.addEventListener('delta', (event) => {
        const delta = parseDelta((event as MessageEvent<string>).data);
        if (delta) {
          setState((previous) => applyDelta(previous, delta));
        }
      });
      source.addEventListener('end', () => {
        stopped = true;
        source?.close();
        setStatus('ended');
      });
    };

    // A hidden tab drops the stream (no point rendering to nobody, and the
    // server poller can wind down); becoming visible resumes from the merged
    // cursor, which by construction misses nothing.
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (!stopped && source) {
          source.close();
          source = undefined;
          setStatus('paused');
        }
      } else if (!stopped && !source) {
        setStatus('connecting');
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      source?.close();
    };
  }, [detail.running, traceId]);

  const view = useMemo<LiveTraceView>(() => {
    if (!detail.running) {
      // Static pass-through: identical to the M3 payload, zero live overhead.
      return {
        trace: detail.trace,
        spans: detail.spans,
        evalResults: detail.evalResults,
        anchorStartNs: detail.anchorStartNs,
        running: false,
      };
    }
    return deriveTraceView(state);
  }, [detail, state]);

  return { view, status };
}

/**
 * A "now" offset (ns since the trace anchor) ticking while the trace runs,
 * for growing in-progress bars. Clamped to never sit behind the last known
 * span end (client/server clock skew must not shrink the waterfall), and
 * frozen at the final duration once the trace completes.
 */
export function useNowOffsetNs(running: boolean, anchorStartNs: string, floorNs: number): number {
  const anchorMs = useMemo(() => Number(BigInt(anchorStartNs) / 1_000_000n), [anchorStartNs]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) {
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  if (!running) {
    return floorNs;
  }
  return Math.max((nowMs - anchorMs) * 1_000_000, floorNs);
}
