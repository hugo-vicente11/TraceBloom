/**
 * Trace query API against real ClickHouse. Skipped unless
 * TRACEBLOOM_TEST_CLICKHOUSE_URL is set (CI's evals job provides it).
 *
 * Seeds one multi-step agent trace straight into ClickHouse, root agent span,
 * chat child, a failed tool attempt plus its retry, an orphan span, a duplicate
 * span row, content events and two eval_result versions, then drives the real
 * route handlers and asserts the payload, the reconstructed tree, and the
 * lazily loaded span detail.
 */

import { createClient } from '@clickhouse/client';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceDetail } from '../lib/traces';

const CH_URL = process.env.TRACEBLOOM_TEST_CLICKHOUSE_URL;
const run = CH_URL ? describe : describe.skip;

// Unique per run so repeated local runs never collide.
const SUFFIX = Date.now().toString(16).padStart(12, '0').slice(-12);
const TRACE_ID = `f${SUFFIX}beef${SUFFIX}bee`.padEnd(32, '0').slice(0, 32);
const ROOT = 'aaaa000000000001';
const CHAT = 'aaaa000000000002';
const TOOL_FAIL = 'aaaa000000000003';
const TOOL_RETRY = 'aaaa000000000004';
const ORPHAN = 'aaaa000000000005';
const MISSING_PARENT = 'ffff000000000000';

const BASE = new Date('2026-07-10T12:00:00.000Z');

function chDateTime(offsetMs: number): string {
  return new Date(BASE.getTime() + offsetMs).toISOString().replace('T', ' ').replace('Z', '');
}

interface SeedSpan {
  span_id: string;
  parent_span_id: string;
  name: string;
  start_ms: number;
  duration_ms: number;
  status_code?: string;
  status_message?: string;
  operation_name?: string;
  request_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  attributes?: Record<string, unknown>;
}

function spanRow(s: SeedSpan): Record<string, unknown> {
  return {
    trace_id: TRACE_ID,
    span_id: s.span_id,
    parent_span_id: s.parent_span_id,
    name: s.name,
    kind: 'INTERNAL',
    start_time: chDateTime(s.start_ms),
    end_time: chDateTime(s.start_ms + s.duration_ms),
    duration_ns: s.duration_ms * 1_000_000,
    status_code: s.status_code ?? 'OK',
    status_message: s.status_message ?? '',
    service_name: 'trace-it',
    scope_name: '@tracebloom/sdk',
    operation_name: s.operation_name ?? '',
    provider: s.operation_name === 'chat' ? 'openai' : '',
    request_model: s.request_model ?? '',
    response_model: s.request_model ?? '',
    input_tokens: s.input_tokens ?? 0,
    output_tokens: s.output_tokens ?? 0,
    total_tokens: (s.input_tokens ?? 0) + (s.output_tokens ?? 0),
    cost_usd: s.cost_usd ?? 0,
    response_id: '',
    finish_reasons: [],
    attributes_json: JSON.stringify(s.attributes ?? {}),
    resource_attributes_json: '{}',
  };
}

run('trace query API (integration)', () => {
  beforeAll(async () => {
    // The dashboard's ClickHouse client reads CLICKHOUSE_URL lazily on first
    // query; point it at the test instance before any handler runs.
    process.env.CLICKHOUSE_URL = CH_URL;

    const ch = createClient({ url: CH_URL, database: 'tracebloom' });
    await ch.insert({
      table: 'tracebloom.spans',
      format: 'JSONEachRow',
      values: [
        spanRow({
          span_id: ROOT,
          parent_span_id: '',
          name: 'invoke_agent researcher',
          start_ms: 0,
          duration_ms: 1000,
          operation_name: 'invoke_agent',
          attributes: { 'gen_ai.agent.name': 'researcher' },
        }),
        spanRow({
          span_id: CHAT,
          parent_span_id: ROOT,
          name: 'chat gpt-4o',
          start_ms: 10,
          duration_ms: 200,
          operation_name: 'chat',
          request_model: 'gpt-4o',
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.00075,
          attributes: { 'gen_ai.prompt.version': 'v2' },
        }),
        spanRow({
          span_id: TOOL_FAIL,
          parent_span_id: ROOT,
          name: 'execute_tool web.search',
          start_ms: 220,
          duration_ms: 80,
          status_code: 'ERROR',
          status_message: 'rate limited',
          operation_name: 'execute_tool',
          attributes: { 'gen_ai.tool.name': 'web.search' },
        }),
        spanRow({
          span_id: TOOL_RETRY,
          parent_span_id: ROOT,
          name: 'execute_tool web.search',
          start_ms: 320,
          duration_ms: 90,
          operation_name: 'execute_tool',
          attributes: { 'gen_ai.tool.name': 'web.search', 'tracebloom.retry.attempt': 2 },
        }),
        spanRow({
          span_id: ORPHAN,
          parent_span_id: MISSING_PARENT,
          name: 'stray step',
          start_ms: 500,
          duration_ms: 10,
        }),
        // Duplicate of the chat span (collector retry): must collapse to one.
        spanRow({
          span_id: CHAT,
          parent_span_id: ROOT,
          name: 'chat gpt-4o',
          start_ms: 10,
          duration_ms: 200,
          operation_name: 'chat',
          request_model: 'gpt-4o',
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.00075,
          attributes: { 'gen_ai.prompt.version': 'v2' },
        }),
      ],
    });

    await ch.insert({
      table: 'tracebloom.span_events',
      format: 'JSONEachRow',
      values: [
        {
          trace_id: TRACE_ID,
          span_id: CHAT,
          event_index: 0,
          name: 'gen_ai.user.message',
          timestamp: chDateTime(10),
          body: JSON.stringify({ content: 'What is TraceBloom?' }),
          attributes_json: '{}',
        },
        {
          trace_id: TRACE_ID,
          span_id: CHAT,
          event_index: 1,
          name: 'gen_ai.choice',
          timestamp: chDateTime(210),
          body: JSON.stringify({ index: 0, finish_reason: 'stop', content: 'An LLM tracer.' }),
          attributes_json: '{}',
        },
      ],
    });

    // Two versions of the same eval for the chat span: only v2 may surface.
    const evalBase = {
      eval_id: `eval-${SUFFIX}`,
      trace_id: TRACE_ID,
      span_id: CHAT,
      response_id: '',
      evaluation_name: 'answer-quality',
      score_label: '',
      error_type: '',
      evaluator_type: 'llm_judge',
      request_model: 'gpt-4o',
      operation_name: 'chat',
      service_name: 'trace-it',
      prompt_version: 'v2',
      variant: 'v2',
      content_hash: 'h',
      span_start_time: chDateTime(10),
      evaluated_at: chDateTime(5000),
      metadata_json: '{}',
    };
    await ch.insert({
      table: 'tracebloom.eval_results',
      format: 'JSONEachRow',
      values: [
        { ...evalBase, eval_version: 1, score_value: 0.4, passed: 0, explanation: 'meh' },
        { ...evalBase, eval_version: 2, score_value: 0.9, passed: 1, explanation: 'solid answer' },
      ],
    });
    await ch.close();
  });

  async function fetchTrace(id: string): Promise<Response> {
    const { GET } = await import('../app/api/traces/[traceId]/route');
    return GET(new Request(`http://test/api/traces/${id}`), {
      params: Promise.resolve({ traceId: id }),
    });
  }

  async function fetchSpan(traceId: string, spanId: string): Promise<Response> {
    const { GET } = await import('../app/api/traces/[traceId]/spans/[spanId]/route');
    return GET(new Request(`http://test/api/traces/${traceId}/spans/${spanId}`), {
      params: Promise.resolve({ traceId, spanId }),
    });
  }

  it('returns all spans of the trace from one query, deduplicated, with aggregates', async () => {
    const response = await fetchTrace(TRACE_ID);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as TraceDetail;

    expect(detail.truncated).toBe(false);
    expect(detail.spans).toHaveLength(5); // duplicate CHAT row collapsed
    expect(detail.trace.spanCount).toBe(5);
    expect(detail.trace.errorCount).toBe(1);
    expect(detail.trace.totalTokens).toBe(150);
    expect(detail.trace.costUsd).toBeCloseTo(0.00075, 10);
    expect(detail.trace.models).toEqual(['gpt-4o']);
    expect(detail.trace.durationNs).toBe(1000 * 1_000_000);

    const chat = detail.spans.find((s) => s.spanId === CHAT)!;
    expect(chat.parentSpanId).toBe(ROOT);
    expect(chat.startOffsetNs).toBe(10 * 1_000_000);
    expect(chat.promptVersion).toBe('v2');
    const retry = detail.spans.find((s) => s.spanId === TOOL_RETRY)!;
    expect(retry.retryAttempt).toBe(2);
    expect(retry.toolName).toBe('web.search');
    const fail = detail.spans.find((s) => s.spanId === TOOL_FAIL)!;
    expect(fail.statusCode).toBe('ERROR');
    expect(fail.statusMessage).toBe('rate limited');
  });

  it('reconstructs the expected tree with orphan handling and roll-ups', async () => {
    const { buildSpanTree } = await import('../lib/trace-tree');
    const detail = (await (await fetchTrace(TRACE_ID)).json()) as TraceDetail;
    const tree = buildSpanTree(detail.spans, detail.evalResults);

    expect(tree.roots.map((n) => n.span.spanId)).toEqual([ROOT, ORPHAN]);
    expect(tree.byId.get(ORPHAN)!.orphaned).toBe(true);
    expect(tree.orphanCount).toBe(1);

    const root = tree.byId.get(ROOT)!;
    expect(root.children.map((n) => n.span.spanId)).toEqual([CHAT, TOOL_FAIL, TOOL_RETRY]);
    expect(root.category).toBe('agent');
    expect(root.rollup.spanCount).toBe(4);
    expect(root.rollup.errorCount).toBe(1);
    expect(root.rollup.retryCount).toBe(1);
    expect(root.rollup.totalTokens).toBe(150);
    expect(root.rollup.evalCount).toBe(1);
    expect(tree.byId.get(CHAT)!.category).toBe('llm');
    expect(tree.byId.get(TOOL_RETRY)!.category).toBe('tool');
  });

  it('surfaces only the latest eval version, attached to the scored span', async () => {
    const detail = (await (await fetchTrace(TRACE_ID)).json()) as TraceDetail;
    expect(detail.evalResults).toHaveLength(1);
    const result = detail.evalResults[0]!;
    expect(result.spanId).toBe(CHAT);
    expect(result.evalVersion).toBe(2);
    expect(result.scoreValue).toBeCloseTo(0.9, 10);
    expect(result.passed).toBe(true);
    expect(result.explanation).toBe('solid answer');
  });

  it('lazy-loads span content events and full attributes on demand', async () => {
    const response = await fetchSpan(TRACE_ID, CHAT);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as {
      attributes: Record<string, unknown>;
      events: { name: string; body: Record<string, unknown> }[];
      statusCode: string;
    };
    expect(detail.attributes['gen_ai.prompt.version']).toBe('v2');
    expect(detail.events.map((e) => e.name)).toEqual(['gen_ai.user.message', 'gen_ai.choice']);
    expect(detail.events[0]!.body.content).toBe('What is TraceBloom?');
  });

  it('returns 404 for an unknown trace or span and 400 for malformed ids', async () => {
    expect((await fetchTrace('0'.repeat(32))).status).toBe(404);
    expect((await fetchTrace('not-a-trace-id')).status).toBe(400);
    expect((await fetchSpan(TRACE_ID, 'dead000000000000')).status).toBe(404);
    expect((await fetchSpan(TRACE_ID, 'nope')).status).toBe(400);
  });
});
