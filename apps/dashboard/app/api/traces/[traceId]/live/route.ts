/**
 * GET /api/traces/:traceId/live: Server-Sent Events stream of span/eval
 * deltas for one trace (DECISIONS.md D20).
 *
 * Protocol: `delta` messages carry a LiveDelta JSON payload and set the SSE
 * event id to the encoded cursor, so the browser's automatic reconnect
 * (`Last-Event-ID`) resumes exactly; a fresh subscription passes the
 * snapshot cursor as `?cursor=`. A terminal `end` message tells the client
 * to stop reconnecting (trace settled or dead). Comment heartbeats keep
 * proxies from idling the connection out.
 */

import { decodeCursor, encodeCursor, type LiveDelta, type LiveEnd } from '../../../../../lib/live';
import { getLiveBroker } from '../../../../../lib/live-broker';
import { enforceRateLimit } from '../../../../../lib/rate-limit';
import { isValidTraceId } from '../../../../../lib/traces';

export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;
/** Consecutive polls a consumer may stay backpressured before being dropped. */
const MAX_BACKPRESSURE_STRIKES = 3;

const encoder = new TextEncoder();

function sseDelta(delta: LiveDelta): Uint8Array {
  return encoder.encode(
    `event: delta\nid: ${encodeCursor(delta.cursor)}\ndata: ${JSON.stringify(delta)}\n\n`,
  );
}

function sseEnd(payload: LiveEnd): Uint8Array {
  return encoder.encode(`event: end\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  const params = await context.params;
  const traceId = params.traceId.toLowerCase();
  if (!isValidTraceId(traceId)) {
    return Response.json({ error: 'invalid trace id' }, { status: 400 });
  }

  // Per-IP cap on opening new streams (429 is non-200, so EventSource stops
  // auto-reconnecting rather than storming). The broker separately bounds the
  // total and per-trace concurrent subscriber counts.
  const limited = enforceRateLimit(request, 'live-sse', { capacity: 15, refillPerSecond: 1 });
  if (limited) {
    return limited;
  }

  // Resume position: automatic EventSource reconnects send Last-Event-ID;
  // fresh subscriptions pass the server-snapshot cursor as a query param.
  const rawCursor =
    request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('cursor');
  if (rawCursor === null) {
    return Response.json({ error: 'missing cursor' }, { status: 400 });
  }
  const cursor = decodeCursor(rawCursor);
  if (!cursor) {
    return Response.json({ error: 'malformed cursor' }, { status: 400 });
  }

  // A non-200 stops EventSource from auto-reconnecting; the client surfaces
  // "too many live viewers" instead of hammering a saturated broker.
  if (!getLiveBroker().canAccept(traceId)) {
    return Response.json(
      { error: 'live subscriber capacity reached' },
      { status: 503, headers: { 'retry-after': '10' } },
    );
  }

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const teardown = (closeController: boolean) => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        unsubscribe?.();
        if (closeController) {
          try {
            controller.close();
          } catch {
            // Already closed/errored by the consumer.
          }
        }
      };

      /** Enqueue one frame; false when the connection is gone. */
      const write = (chunk: Uint8Array): boolean => {
        if (closed) {
          return false;
        }
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          teardown(false);
          return false;
        }
      };

      let strikes = 0;
      const result = getLiveBroker().subscribe(traceId, cursor, {
        send: (delta) => {
          // Backpressure: desiredSize goes (and stays) negative when the
          // client socket cannot drain what we enqueue. Rather than buffer
          // without bound, drop the consumer after a few strained polls —
          // its reconnect resumes from the cursor, self-healing the backlog.
          if (controller.desiredSize !== null && controller.desiredSize < 0) {
            strikes += 1;
            if (strikes > MAX_BACKPRESSURE_STRIKES) {
              teardown(true);
              return false;
            }
          } else {
            strikes = 0;
          }
          return write(sseDelta(delta));
        },
        end: (reason) => {
          write(sseEnd({ reason }));
          teardown(true);
        },
        close: () => {
          teardown(true);
        },
      });

      if (!result.ok) {
        write(encoder.encode(': over capacity\n\n'));
        teardown(true);
        return;
      }
      unsubscribe = result.unsubscribe;

      // Ask EventSource to wait 3s before reconnecting after a drop, and
      // heartbeat so intermediaries keep the idle connection open.
      write(encoder.encode('retry: 3000\n\n'));
      heartbeat = setInterval(() => {
        write(encoder.encode(': hb\n\n'));
      }, HEARTBEAT_MS);

      // Client disconnects surface as request aborts and/or stream cancel.
      request.signal.addEventListener('abort', () => teardown(false), { once: true });
    },
    cancel() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      closed = true;
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell nginx-style proxies not to buffer the stream.
      'x-accel-buffering': 'no',
    },
  });
}
