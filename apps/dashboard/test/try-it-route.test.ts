/**
 * /api/try-it: per-IP rate limiting and error mapping. The sandbox itself is
 * mocked: its own caps are covered by sandbox.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSandboxRun = vi.fn();
vi.mock('../lib/sandbox', () => ({
  startSandboxRun: (...args: unknown[]) => startSandboxRun(...args),
}));

import { POST } from '../app/api/try-it/route';

function post(ip: string): Promise<Response> {
  return POST(
    new Request('http://demo/api/try-it', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
    }),
  );
}

describe('POST /api/try-it', () => {
  beforeEach(() => {
    startSandboxRun.mockReset();
    startSandboxRun.mockResolvedValue({
      ok: true,
      traceId: 'a'.repeat(32),
      done: Promise.resolve(),
    });
    // Fresh limiter per test: the route keeps it on globalThis.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('tracebloom.try-it-limiter')];
  });

  it('starts a run and returns its trace id', async () => {
    const response = await post('203.0.113.1');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ traceId: 'a'.repeat(32) });
  });

  it('rate limits per client ip with Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post('203.0.113.2')).status).toBe(202);
    }
    const limited = await post('203.0.113.2');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A different visitor is unaffected.
    expect((await post('203.0.113.3')).status).toBe(202);
    expect(startSandboxRun).toHaveBeenCalledTimes(4);
  });

  it('maps sandbox capacity and budget to 503 + Retry-After', async () => {
    startSandboxRun.mockResolvedValueOnce({ ok: false, reason: 'concurrency' });
    const busy = await post('203.0.113.4');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('15');

    startSandboxRun.mockResolvedValueOnce({ ok: false, reason: 'budget' });
    const exhausted = await post('203.0.113.5');
    expect(exhausted.status).toBe(503);
    expect(exhausted.headers.get('retry-after')).toBe('3600');
  });

  it('maps sandbox failures to 500', async () => {
    startSandboxRun.mockRejectedValueOnce(new Error('collector unreachable'));
    const response = await post('203.0.113.6');
    expect(response.status).toBe(500);
  });
});
