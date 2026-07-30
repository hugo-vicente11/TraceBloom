/**
 * Fan-out broker for live trace subscriptions (server only).
 *
 * One TracePoller per trace id, shared by every subscriber to that trace: a
 * poll tick issues exactly one delta fetch and broadcasts the result, so
 * ClickHouse load scales with the number of *watched traces*, never with the
 * number of open tabs. Subscribers that joined behind the poller's head get
 * one catch-up fetch from their own cursor and then ride the shared
 * broadcast (attach-first, so nothing published in between is missed, the
 * client merge makes the overlap idempotent).
 *
 * Bounds (DECISIONS.md D23):
 * - subscriber caps (global + per trace) reject new connections up front;
 * - a slow consumer is dropped (its `send` returns false) and resumes from
 *   its cursor on reconnect, rather than buffering unboundedly;
 * - pollers end themselves once the trace has settled (root seen + quiet)
 *   or looks dead (no root, long quiet), and stop the moment the last
 *   subscriber leaves: no orphaned timers or tasks.
 *
 * The collector is never touched: this whole module reads ClickHouse from
 * the dashboard process. Ingestion isolation is by construction (D21).
 */

import type { LiveCursor, LiveDelta, LiveEnd } from './live';
import { type FetchDeltas, fetchTraceDeltas } from './live-deltas';
import type { SpanEvalResult } from './traces';

/** Identity of an eval-result row for boundary-replay tracking. */
function evalRowKey(result: SpanEvalResult): string {
  return `${result.evalId} ${result.spanId} ${result.evalVersion}`;
}

/** How one connection receives its stream. All methods must not throw. */
export interface LiveSubscriber {
  /**
   * Deliver one delta. Return false to signal an unrecoverable consumer
   * (closed or persistently backpressured): the broker drops the
   * subscription and the client resumes from its cursor on reconnect.
   */
  send(delta: LiveDelta): boolean;
  /** Terminal notice: the trace settled or went dead. Close politely. */
  end(reason: LiveEnd['reason']): void;
  /**
   * Close without a terminal notice (broker trouble, e.g. ClickHouse
   * unreachable). EventSource auto-reconnects and resumes from the cursor.
   */
  close(): void;
}

export interface BrokerConfig {
  fetchDeltas: FetchDeltas;
  /** Poll cadence while the trace is running (no root span yet). */
  fastPollMs: number;
  /** Poll cadence once the root landed (late spans / eval scores trickle). */
  slowPollMs: number;
  /** End the stream this long after the last delta once the root has landed. */
  settledEndMs: number;
  /** End the stream this long after the last delta when no root ever landed. */
  deadEndMs: number;
  /** Drop the poller after this many consecutive failed fetches. */
  maxConsecutiveErrors: number;
  maxSubscribers: number;
  maxSubscribersPerTrace: number;
}

export const DEFAULT_BROKER_CONFIG: Omit<BrokerConfig, 'fetchDeltas'> = {
  fastPollMs: 800,
  slowPollMs: 2_500,
  settledEndMs: 5 * 60 * 1000,
  deadEndMs: 10 * 60 * 1000,
  maxConsecutiveErrors: 5,
  maxSubscribers: 200,
  maxSubscribersPerTrace: 20,
};

/** Introspection for tests and the health surface. */
export interface BrokerStats {
  pollers: number;
  subscribers: number;
  /** Total delta fetches issued (catch-ups included). */
  fetches: number;
}

class TracePoller {
  private readonly subscribers = new Set<LiveSubscriber>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private stopped = false;
  private head: LiveCursor;
  private rootSeen = false;
  private lastDataAt = Date.now();
  private consecutiveErrors = 0;
  // The delta bound is INCLUSIVE (`>=`, see live-deltas.ts), so rows sitting
  // exactly at the head watermark are re-fetched on every poll. These sets
  // remember which of them were already delivered: they are trimmed from the
  // broadcast and do not count as fresh data: without this, a quiet trace
  // would re-broadcast its newest row forever and the poller could never
  // observe silence (and thus never end itself).
  private spanBoundary = new Set<string>();
  private evalBoundary = new Set<string>();

  constructor(
    private readonly broker: LiveBroker,
    private readonly traceId: string,
    initialCursor: LiveCursor,
    private readonly config: BrokerConfig,
  ) {
    this.head = initialCursor;
  }

  get size(): number {
    return this.subscribers.size;
  }

  attach(subscriber: LiveSubscriber, cursor: LiveCursor): void {
    this.subscribers.add(subscriber);
    // Attach BEFORE catching up: a broadcast landing mid-catch-up reaches
    // the subscriber too, so the union of (catch-up ∪ broadcasts) has no
    // gap; overlap is deduplicated by the client merge.
    if (cursor.spanMs < this.head.spanMs || cursor.evalMs < this.head.evalMs) {
      void this.catchUp(subscriber, cursor);
    }
    if (this.timer === undefined && !this.polling && !this.stopped) {
      this.schedule(0);
    }
  }

  detach(subscriber: LiveSubscriber): void {
    if (!this.subscribers.delete(subscriber)) {
      return;
    }
    this.broker.onDetached();
    if (this.subscribers.size === 0) {
      this.stop();
    }
  }

  /** Stop polling and remove the poller from the registry. */
  private stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.broker.removePoller(this.traceId, this);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.polling = true;
    try {
      const fetched = await this.config.fetchDeltas(this.traceId, this.head);
      this.broker.countFetch();
      this.consecutiveErrors = 0;
      const delta = this.trimBoundaryReplays(fetched);
      this.head = delta.cursor;
      this.rootSeen = this.rootSeen || delta.rootSeen;
      if (delta.spans.length > 0 || delta.evals.length > 0) {
        this.lastDataAt = Date.now();
        this.broadcast(delta);
      }
    } catch (error) {
      this.consecutiveErrors += 1;
      console.error(
        `[live] delta fetch failed for trace ${this.traceId} ` +
          `(${this.consecutiveErrors}/${this.config.maxConsecutiveErrors}):`,
        error,
      );
      if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
        // Close WITHOUT an end event: clients auto-reconnect with their
        // cursor and get a fresh poller once ClickHouse is reachable again.
        this.closeAll();
        return;
      }
    } finally {
      this.polling = false;
    }

    if (this.stopped) {
      return;
    }

    const quietMs = Date.now() - this.lastDataAt;
    if (this.rootSeen && quietMs >= this.config.settledEndMs) {
      this.endAll('complete');
      return;
    }
    if (!this.rootSeen && quietMs >= this.config.deadEndMs) {
      this.endAll('idle');
      return;
    }

    this.schedule(this.rootSeen ? this.config.slowPollMs : this.config.fastPollMs);
  }

  /**
   * Drop rows that sit exactly at the previous watermark and were already
   * delivered (the price of the gap-free inclusive bound), and remember the
   * rows now sitting at the new watermark for the next tick.
   */
  private trimBoundaryReplays(fetched: LiveDelta): LiveDelta {
    const prev = this.head;
    const spans = fetched.spans.filter(
      (span) => span.ingestedMs > prev.spanMs || !this.spanBoundary.has(span.spanId),
    );
    const evals = fetched.evals.filter(
      (result) =>
        (result.evaluatedMs ?? 0) > prev.evalMs || !this.evalBoundary.has(evalRowKey(result)),
    );

    // Rebuild the boundary sets at the NEW watermark from everything fetched
    // replays included: while the watermark holds still they remain on the
    // boundary and must stay remembered.
    const nextSpans = fetched.cursor.spanMs === prev.spanMs ? this.spanBoundary : new Set<string>();
    for (const span of fetched.spans) {
      if (span.ingestedMs === fetched.cursor.spanMs) {
        nextSpans.add(span.spanId);
      }
    }
    this.spanBoundary = nextSpans;

    const nextEvals = fetched.cursor.evalMs === prev.evalMs ? this.evalBoundary : new Set<string>();
    for (const result of fetched.evals) {
      if (result.evaluatedMs === fetched.cursor.evalMs) {
        nextEvals.add(evalRowKey(result));
      }
    }
    this.evalBoundary = nextEvals;

    return { ...fetched, spans, evals };
  }

  private async catchUp(subscriber: LiveSubscriber, cursor: LiveCursor): Promise<void> {
    try {
      const delta = await this.config.fetchDeltas(this.traceId, cursor);
      this.broker.countFetch();
      if (!this.subscribers.has(subscriber)) {
        return; // Detached while the catch-up query ran.
      }
      if ((delta.spans.length > 0 || delta.evals.length > 0) && !subscriber.send(delta)) {
        this.detach(subscriber);
      }
    } catch (error) {
      console.error(`[live] catch-up fetch failed for trace ${this.traceId}:`, error);
      // The shared poll loop still covers everything past the poller head;
      // the subscriber reconnects from its cursor if it notices a gap-shaped
      // hole (it cannot: its cursor is only advanced by delivered deltas).
      subscriber.close();
      this.detach(subscriber);
    }
  }

  private broadcast(delta: LiveDelta): void {
    for (const subscriber of [...this.subscribers]) {
      if (!subscriber.send(delta)) {
        this.detach(subscriber);
      }
    }
  }

  private endAll(reason: LiveEnd['reason']): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber.end(reason);
      this.detach(subscriber);
    }
  }

  private closeAll(): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber.close();
      this.detach(subscriber);
    }
  }
}

/** Result of a subscribe attempt. */
export type SubscribeResult =
  | { ok: true; unsubscribe: () => void }
  | { ok: false; reason: 'capacity' };

export class LiveBroker {
  private readonly pollers = new Map<string, TracePoller>();
  private readonly config: BrokerConfig;
  private subscriberCount = 0;
  private fetchCount = 0;

  constructor(config: Partial<BrokerConfig> & Pick<BrokerConfig, 'fetchDeltas'>) {
    this.config = { ...DEFAULT_BROKER_CONFIG, ...config };
  }

  /** Cheap pre-check so the route can reject with a real 503 up front. */
  canAccept(traceId: string): boolean {
    return (
      this.subscriberCount < this.config.maxSubscribers &&
      (this.pollers.get(traceId)?.size ?? 0) < this.config.maxSubscribersPerTrace
    );
  }

  subscribe(traceId: string, cursor: LiveCursor, subscriber: LiveSubscriber): SubscribeResult {
    if (!this.canAccept(traceId)) {
      return { ok: false, reason: 'capacity' };
    }
    const existing = this.pollers.get(traceId);

    let poller = existing;
    if (!poller) {
      poller = new TracePoller(this, traceId, cursor, this.config);
      this.pollers.set(traceId, poller);
    }
    this.subscriberCount += 1;
    poller.attach(subscriber, cursor);

    let done = false;
    return {
      ok: true,
      unsubscribe: () => {
        // Idempotent: cancel/abort/end can all fire for one connection.
        if (!done) {
          done = true;
          poller.detach(subscriber);
        }
      },
    };
  }

  /** @internal poller bookkeeping */
  onDetached(): void {
    this.subscriberCount -= 1;
  }

  /** @internal poller bookkeeping */
  removePoller(traceId: string, poller: TracePoller): void {
    if (this.pollers.get(traceId) === poller) {
      this.pollers.delete(traceId);
    }
  }

  /** @internal poller bookkeeping */
  countFetch(): void {
    this.fetchCount += 1;
  }

  stats(): BrokerStats {
    return {
      pollers: this.pollers.size,
      subscribers: this.subscriberCount,
      fetches: this.fetchCount,
    };
  }
}

// One broker per server process, stashed on globalThis so Next dev-mode HMR
// (which re-evaluates modules) cannot leak a second registry of live timers.
const BROKER_KEY = Symbol.for('tracebloom.live-broker');

/** The process-wide broker used by the SSE route (real ClickHouse deltas). */
export function getLiveBroker(): LiveBroker {
  const holder = globalThis as { [BROKER_KEY]?: LiveBroker };
  holder[BROKER_KEY] ??= new LiveBroker({ fetchDeltas: fetchTraceDeltas });
  return holder[BROKER_KEY];
}
