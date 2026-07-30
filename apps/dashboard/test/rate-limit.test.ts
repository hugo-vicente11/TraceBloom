import { describe, expect, it } from 'vitest';
import { clientKey, TokenBucketLimiter } from '../lib/rate-limit';

function limiterAt(capacity: number, refillPerSecond: number, maxKeys?: number) {
  let nowMs = 0;
  const limiter = new TokenBucketLimiter({ capacity, refillPerSecond, maxKeys }, () => nowMs);
  return { limiter, advance: (ms: number) => (nowMs += ms) };
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity, then rejects with a retry hint', () => {
    const { limiter } = limiterAt(3, 1 / 60);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    const rejected = limiter.tryAcquire('ip');
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('refills continuously over time', () => {
    const { limiter, advance } = limiterAt(2, 1 / 10); // one token per 10s
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(false);
    advance(10_000);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(false);
  });

  it('never exceeds capacity after a long idle period', () => {
    const { limiter, advance } = limiterAt(2, 1);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    advance(3_600_000);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(true);
    expect(limiter.tryAcquire('ip').allowed).toBe(false);
  });

  it('isolates keys and evicts the least recently seen past maxKeys', () => {
    const { limiter } = limiterAt(1, 0, 2);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('b').allowed).toBe(true);
    expect(limiter.tryAcquire('a').allowed).toBe(false); // still tracked
    expect(limiter.tryAcquire('c').allowed).toBe(true); // evicts b (LRU)
    expect(limiter.size).toBe(2);
    // b was evicted, so it gets a fresh bucket.
    expect(limiter.tryAcquire('b').allowed).toBe(true);
  });
});

describe('clientKey', () => {
  it('uses the first x-forwarded-for hop', () => {
    const request = new Request('http://x/', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    });
    expect(clientKey(request)).toBe('203.0.113.9');
  });

  it('falls back to a shared key without the header', () => {
    expect(clientKey(new Request('http://x/'))).toBe('local');
  });
});
