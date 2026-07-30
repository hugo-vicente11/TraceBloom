/**
 * End-to-end smoke test for the core loop: SDK -> collector -> ClickHouse ->
 * the query the dashboard runs.
 *
 * The LLM provider is mocked (no API key needed): we wrap a fake OpenAI-shaped
 * client with the real SDK, emit a span to a *running* collector, then poll
 * ClickHouse and assert the span landed with the right gen_ai fields and that it
 * shows up in the dashboard's recent-traces aggregation.
 *
 * Requires the collector + ClickHouse to be up (e.g. `docker compose up`).
 * Exits non-zero on any failure so CI can gate on it.
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@clickhouse/client';
import {
  type ChatCompletionResponse,
  init,
  instrumentOpenAI,
  type OpenAILike,
  shutdown,
} from '@tracebloom/sdk';

const COLLECTOR_ENDPOINT = process.env.TRACEBLOOM_ENDPOINT ?? 'http://localhost:4318';
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? 'tracebloom';
// A unique service name lets us find exactly this run's span without knowing the
// trace id the SDK generated.
const SERVICE_NAME = `smoke-${Date.now()}`;

interface SpanRow {
  trace_id: string;
  request_model: string;
  total_tokens: string;
  cost_usd: number;
  status_code: string;
}

interface TraceAggRow {
  trace_id: string;
  total_tokens: string;
}

/** A fake OpenAI client: same structural shape, canned response, zero network. */
function mockOpenAI(): OpenAILike {
  return {
    chat: {
      completions: {
        create: async (): Promise<ChatCompletionResponse> => ({
          id: 'chatcmpl-smoke',
          model: 'gpt-4o-2024-08-06',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      },
    },
  };
}

async function main(): Promise<void> {
  console.log(
    `[smoke] collector=${COLLECTOR_ENDPOINT} clickhouse=${CLICKHOUSE_URL} service=${SERVICE_NAME}`,
  );

  init({ endpoint: COLLECTOR_ENDPOINT, serviceName: SERVICE_NAME, captureContent: true });
  const openai = instrumentOpenAI(mockOpenAI());

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(
    response.id,
    'chatcmpl-smoke',
    'wrapper must return the provider response unchanged',
  );

  // Flush the batch span processor to the collector, then close the SDK.
  await shutdown();
  console.log('[smoke] span exported; polling ClickHouse...');

  const ch = createClient({ url: CLICKHOUSE_URL, database: CLICKHOUSE_DATABASE });

  // 1) The span itself, with gen_ai fields promoted to typed columns.
  let span: SpanRow | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rs = await ch.query({
      query: `SELECT trace_id, request_model, toString(total_tokens) AS total_tokens, cost_usd, status_code
              FROM tracebloom.spans WHERE service_name = {svc:String} LIMIT 1`,
      query_params: { svc: SERVICE_NAME },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<SpanRow>();
    if (rows.length > 0) {
      span = rows[0];
      break;
    }
    await sleep(500);
  }

  assert.ok(span, `no span landed in ClickHouse for service "${SERVICE_NAME}" within timeout`);
  assert.equal(span.request_model, 'gpt-4o', 'request_model');
  assert.equal(Number(span.total_tokens), 18, 'total_tokens');
  assert.equal(span.status_code, 'OK', 'status_code');
  assert.ok(span.cost_usd > 0, `cost_usd should be > 0, got ${span.cost_usd}`);

  // 2) The same data via the dashboard's per-trace aggregation.
  const aggRs = await ch.query({
    query: `SELECT trace_id, toString(sum(total_tokens)) AS total_tokens
            FROM tracebloom.spans WHERE service_name = {svc:String}
            GROUP BY trace_id`,
    query_params: { svc: SERVICE_NAME },
    format: 'JSONEachRow',
  });
  const traces = await aggRs.json<TraceAggRow>();
  assert.equal(traces.length, 1, 'dashboard aggregation should show exactly one trace');
  assert.equal(Number(traces[0]?.total_tokens), 18, 'aggregated token total');

  // 3) The content event (captureContent was on) landed in span_events. The
  // collector flushes spans and span_events as two sequential inserts, so the
  // spans row (checked above) can become visible slightly before the
  // span_events row does; poll here too rather than a single one-shot read.
  let eventCount = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const eventRs = await ch.query({
      query: `SELECT count() AS c FROM tracebloom.span_events WHERE trace_id = {tid:String}`,
      query_params: { tid: span.trace_id },
      format: 'JSONEachRow',
    });
    const row = (await eventRs.json<{ c: string }>())[0];
    eventCount = row ? Number(row.c) : 0;
    if (eventCount > 0) {
      break;
    }
    await sleep(500);
  }
  assert.ok(eventCount >= 1, 'expected at least one content span_event');

  await ch.close();

  console.log(
    `[smoke] ✅ trace ${span.trace_id} — model=${span.request_model} tokens=${span.total_tokens} cost=$${span.cost_usd}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[smoke] ❌ failed:', error);
    process.exit(1);
  });
