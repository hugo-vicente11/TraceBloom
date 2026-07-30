/**
 * GET /api/traces/:traceId/spans/:spanId: one span's full attributes and
 * content events (prompt/response messages, exceptions). This is the lazy
 * path: the viewer calls it only when a span is opened, so content is never
 * bulk-fetched for a trace. See DECISIONS.md D14.
 */

import { serverError } from '../../../../../../lib/api-error';
import { enforceRateLimit } from '../../../../../../lib/rate-limit';
import { getSpanDetail, isValidSpanId, isValidTraceId } from '../../../../../../lib/traces';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string; spanId: string }> },
): Promise<Response> {
  const limited = enforceRateLimit(request, 'span-detail', { capacity: 120, refillPerSecond: 4 });
  if (limited) {
    return limited;
  }
  const params = await context.params;
  const traceId = params.traceId.toLowerCase();
  const spanId = params.spanId.toLowerCase();
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
    return Response.json({ error: 'invalid trace or span id' }, { status: 400 });
  }
  try {
    const detail = await getSpanDetail(traceId, spanId);
    if (!detail) {
      return Response.json({ error: 'span not found' }, { status: 404 });
    }
    return Response.json(detail);
  } catch (cause) {
    return serverError(`span detail ${traceId}/${spanId}`, cause);
  }
}
