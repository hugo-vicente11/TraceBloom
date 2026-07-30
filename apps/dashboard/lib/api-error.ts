/**
 * Uniform 500 handling for API routes. Raw exception messages can carry
 * internals (ClickHouse/Postgres error text, query fragments, connection
 * details), so they are logged server-side and never returned to the client —
 * the response body is a fixed, generic message. 4xx responses stay specific
 * (they describe the caller's own bad input, e.g. "invalid trace id").
 */

export function serverError(context: string, cause: unknown): Response {
  console.error(`[api] ${context}:`, cause);
  return Response.json({ error: 'Internal server error.' }, { status: 500 });
}
