/**
 * GET /api/status: dependency health for the landing page's status dot and
 * for watching the demo instance itself: pings ClickHouse, Postgres and the
 * collector's /health. Results are cached briefly in-process so public
 * polling costs at most one fan-out per TTL. Distinct from /api/health, which
 * is the container liveness probe and must not depend on anything.
 */

import { getClient } from '../../../lib/clickhouse';
import { isPublicDemo } from '../../../lib/demo-mode';
import { pingConfigDb } from '../../../lib/evals';
import { enforceRateLimit } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 5_000;
const CHECK_TIMEOUT_MS = 3_000;

type ServiceState = 'ok' | 'error';

export interface StatusPayload {
  ok: boolean;
  demo: boolean;
  services: Record<'clickhouse' | 'postgres' | 'collector', ServiceState>;
  checkedAt: string;
}

let cached: { payload: StatusPayload; atMs: number } | undefined;

async function check(run: () => Promise<unknown>): Promise<ServiceState> {
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('status check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function collectStatus(): Promise<StatusPayload> {
  const collectorEndpoint = (process.env.TRACEBLOOM_ENDPOINT || 'http://localhost:4318').replace(
    /\/+$/,
    '',
  );
  const [clickhouse, postgres, collector] = await Promise.all([
    check(() => getClient().query({ query: 'SELECT 1', format: 'JSONEachRow' })),
    check(() => pingConfigDb()),
    check(async () => {
      const response = await fetch(`${collectorEndpoint}/health`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`collector health ${response.status}`);
      }
    }),
  ]);
  const services = { clickhouse, postgres, collector };
  return {
    ok: Object.values(services).every((state) => state === 'ok'),
    demo: isPublicDemo(),
    services,
    checkedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, 'status', { capacity: 60, refillPerSecond: 1 });
  if (limited) {
    return limited;
  }
  const now = Date.now();
  if (!cached || now - cached.atMs > CACHE_TTL_MS) {
    cached = { payload: await collectStatus(), atMs: now };
  }
  return Response.json(cached.payload, {
    status: cached.payload.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
