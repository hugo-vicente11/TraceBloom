/**
 * GET /api/traces/:traceId: every span of one trace (single ClickHouse
 * query) plus its eval results, as consumed by the trace viewer. Content is
 * NOT included; it is lazy-loaded per span via the sibling spans/:spanId
 * route. See lib/traces.ts and DECISIONS.md D13.
 */

import { serverError } from '../../../../lib/api-error';
import { enforceRateLimit } from '../../../../lib/rate-limit';
import { getTraceDetail, isValidTraceId } from '../../../../lib/traces';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  const limited = enforceRateLimit(request, 'trace-detail', { capacity: 120, refillPerSecond: 4 });
  if (limited) {
    return limited;
  }
  const { traceId } = await context.params;
  const id = traceId.toLowerCase();
  if (!isValidTraceId(id)) {
    return Response.json({ error: 'trace id must be 32 lowercase hex chars' }, { status: 400 });
  }
  try {
    const detail = await getTraceDetail(id);
    if (!detail) {
      return Response.json({ error: 'trace not found' }, { status: 404 });
    }
    return Response.json(detail);
  } catch (cause) {
    return serverError(`trace detail ${id}`, cause);
  }
}
