/**
 * GET /api/traces/live: the currently-running traces (no root span yet,
 * recent ingest activity), polled by the trace list's live rail. Server-side
 * result caching in lib/live-list bounds ClickHouse load regardless of how
 * many tabs poll.
 */

import { serverError } from '../../../../lib/api-error';
import { runningTraces } from '../../../../lib/live-list';
import { enforceRateLimit } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, 'live-list', { capacity: 60, refillPerSecond: 2 });
  if (limited) {
    return limited;
  }
  try {
    const traces = await runningTraces();
    return Response.json({ traces });
  } catch (cause) {
    return serverError('live list', cause);
  }
}
