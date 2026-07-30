/**
 * POST /api/try-it: start one bounded sandbox agent run (see lib/sandbox.ts)
 * and return its trace id; the client polls /api/traces/:id until the first
 * span lands, then opens the live viewer.
 *
 * Abuse posture, outermost first: Caddy body/timeout limits -> per-IP token
 * bucket here (3 runs, refilling one per ~3.3 min) -> global concurrency cap
 * and daily budget inside the sandbox itself. 429/503 carry Retry-After.
 */

import { serverError } from '../../../lib/api-error';
import { clientKey, TokenBucketLimiter } from '../../../lib/rate-limit';
import { startSandboxRun } from '../../../lib/sandbox';

export const dynamic = 'force-dynamic';

const PER_IP = { capacity: 3, refillPerSecond: 3 / 600 };

// globalThis so dev-mode HMR does not reset visitors' budgets.
const LIMITER_KEY = Symbol.for('tracebloom.try-it-limiter');
function limiter(): TokenBucketLimiter {
  const holder = globalThis as { [LIMITER_KEY]?: TokenBucketLimiter };
  holder[LIMITER_KEY] ??= new TokenBucketLimiter(PER_IP);
  return holder[LIMITER_KEY];
}

export async function POST(request: Request): Promise<Response> {
  const decision = limiter().tryAcquire(clientKey(request));
  if (!decision.allowed) {
    return Response.json(
      { error: 'Rate limit reached — the sandbox allows a few runs per visitor per 10 minutes.' },
      { status: 429, headers: { 'retry-after': String(decision.retryAfterSeconds) } },
    );
  }

  try {
    const result = await startSandboxRun();
    if (!result.ok) {
      const message =
        result.reason === 'concurrency'
          ? 'All sandbox slots are busy — try again in a few seconds.'
          : 'The sandbox reached its daily run budget — come back tomorrow.';
      return Response.json(
        { error: message },
        {
          status: 503,
          headers: { 'retry-after': result.reason === 'concurrency' ? '15' : '3600' },
        },
      );
    }
    // Fire-and-forget: the run streams on; failures are logged in the sandbox.
    void result.done;
    return Response.json({ traceId: result.traceId }, { status: 202 });
  } catch (cause) {
    return serverError('try-it start', cause);
  }
}
