/**
 * In-process token-bucket rate limiter for the public demo endpoints.
 *
 * Per-key (client IP) buckets refill continuously; a request that cannot take
 * a token is rejected with the seconds-until-next-token so routes can send
 * Retry-After. Bounded memory: least-recently-seen keys are evicted past
 * maxKeys. In-process state is the right scope here, the demo is a single
 * dashboard instance behind one Caddy (DECISIONS.md D26); anything horizontal
 * would need a shared store instead.
 */

export interface RateLimitOptions {
  /** Bucket capacity (burst size). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Max distinct keys tracked before least-recently-seen eviction. */
  maxKeys?: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxKeys: number;

  constructor(
    options: RateLimitOptions,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  tryAcquire(key: string, tokens = 1): RateLimitDecision {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Refresh, then re-insert so Map iteration order doubles as LRU order.
      const elapsedSeconds = Math.max(0, nowMs - bucket.updatedMs) / 1000;
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedSeconds * this.refillPerSecond,
      );
      bucket.updatedMs = nowMs;
      this.buckets.delete(key);
    } else {
      bucket = { tokens: this.capacity, updatedMs: nowMs };
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) {
          this.buckets.delete(oldest.value);
        }
      }
    }
    this.buckets.set(key, bucket);

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true };
    }
    const deficit = tokens - bucket.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.refillPerSecond)),
    };
  }

  /** Tracked key count (tests / stats). */
  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Client key for rate limiting. Behind the prod Caddy (the only way to reach
 * the dashboard in the public deployment) x-forwarded-for is set by the proxy
 * and trustworthy; its first hop is the client. Without it (local dev), all
 * clients share one bucket: fine for a single developer.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'local';
}

/**
 * Process-wide named limiters, stashed on globalThis so Next dev-mode HMR does
 * not reset visitors' buckets between module reloads (same pattern the try-it
 * route uses for its own limiter).
 */
function namedLimiter(name: string, options: RateLimitOptions): TokenBucketLimiter {
  const key = Symbol.for(`tracebloom.ratelimit.${name}`);
  const holder = globalThis as Record<symbol, TokenBucketLimiter | undefined>;
  holder[key] ??= new TokenBucketLimiter(options);
  return holder[key] as TokenBucketLimiter;
}

// Rate limiting is a production concern; disable it under the test runner so
// integration tests can open many streams from one key (e.g. to exercise the
// broker's per-trace subscriber cap) without tripping per-IP buckets first. The
// TokenBucketLimiter and clientKey are unit-tested directly (rate-limit.test.ts)
// and the live try-it limit is covered end-to-end by infra/prod/smoke.sh.
const RATE_LIMIT_DISABLED = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

/**
 * Per-IP rate limit for a public read/SSE endpoint. Returns a ready-to-send 429
 * (with Retry-After) when the caller is over budget, or `null` to proceed.
 * Limits are deliberately generous: the live viewer polls, so normal browsing
 * never trips them; they exist to bound scripted floods against the read APIs.
 */
export function enforceRateLimit(
  request: Request,
  name: string,
  options: RateLimitOptions,
): Response | null {
  if (RATE_LIMIT_DISABLED) {
    return null;
  }
  const decision = namedLimiter(name, options).tryAcquire(clientKey(request));
  if (decision.allowed) {
    return null;
  }
  return Response.json(
    { error: 'Too many requests — please slow down.' },
    { status: 429, headers: { 'retry-after': String(decision.retryAfterSeconds) } },
  );
}
