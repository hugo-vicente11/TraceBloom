/**
 * GET /api/health: liveness probe for the container HEALTHCHECK.
 *
 * Deliberately dependency-free: it answers 200 while the server process runs,
 * even if ClickHouse/Postgres are briefly down (pages degrade gracefully and
 * recover on their own; restarting the dashboard would not help). Dependency
 * health is reported separately by /api/status.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}
