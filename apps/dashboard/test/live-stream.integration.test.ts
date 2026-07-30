/**
 * Live SSE channel against real ClickHouse. Skipped unless
 * TRACEBLOOM_TEST_CLICKHOUSE_URL is set (CI's evals job provides it).
 *
 * Drives the real route handler end to end: spans inserted in waves stream
 * to a subscriber in arrival order; a reconnect with the last received
 * event id resumes with NO GAP and NO CLIENT-VISIBLE DUPES (asserted by
 * folding every received delta through the client merge); eval_results
 * stream onto the trace; aborting the request tears the poller down; and
 * concurrent subscribers share one poller (the ingest-isolation bound).
 */

import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyDelta, type LiveDelta, seedLiveState } from '../lib/live';
import { getLiveBroker } from '../lib/live-broker';

const CH_URL = process.env.TRACEBLOOM_TEST_CLICKHOUSE_URL;
const run = CH_URL ? describe : describe.skip;

const SUFFIX = Date.now().toString(16).padStart(12, '0').slice(-12);
const TRACE_ID = `e${SUFFIX}cafe${SUFFIX}fee`.padEnd(32, '0').slice(0, 32);
const ROOT = 'bbbb000000000001';
const CHAT = 'bbbb000000000002';
const TOOL = 'bbbb000000000003';
const LATE = 'bbbb000000000004';

const BASE = new Date('2026-07-12T09:00:00.000Z');

function chDateTime(offsetMs: number): string {
  return new Date(BASE.getTime() + offsetMs).toISOString().replace('T', ' ').replace('Z', '');
}

function spanRow(spanId: string, parentSpanId: string, name: string, startMs: number) {
  return {
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: parentSpanId,
    name,
    kind: 'INTERNAL',
    start_time: chDateTime(startMs),
    end_time: chDateTime(startMs + 100),
    duration_ns: 100_000_000,
    status_code: 'OK',
    status_message: '',
    service_name: 'live-it',
    scope_name: '@tracebloom/sdk',
    operation_name: '',
    provider: '',
    request_model: '',
    response_model: '',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    response_id: '',
    finish_reasons: [],
    attributes_json: '{}',
    resource_attributes_json: '{}',
  };
}

function evalRow(spanId: string) {
  return {
    eval_id: 'eval-live',
    eval_version: 1,
    trace_id: TRACE_ID,
    span_id: spanId,
    response_id: '',
    evaluation_name: 'live-check',
    score_value: 0.8,
    score_label: 'pass',
    passed: 1,
    explanation: 'looks good',
    error_type: '',
    evaluator_type: 'deterministic',
    request_model: '',
    operation_name: '',
    service_name: 'live-it',
    prompt_version: '',
    variant: '',
    content_hash: '',
    span_start_time: chDateTime(0),
    metadata_json: '{}',
  };
}

interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

/** Incremental SSE reader over a route Response body. */
class SseReader {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  readonly messages: SseMessage[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pumping: Promise<void>;

  constructor(response: Response) {
    const body = response.body;
    if (!body) {
      throw new Error('SSE response has no body');
    }
    this.reader = body.getReader();
    this.pumping = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          return;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        let index = this.buffer.indexOf('\n\n');
        while (index >= 0) {
          this.parseFrame(this.buffer.slice(0, index));
          this.buffer = this.buffer.slice(index + 2);
          index = this.buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted: fine, the test tears the connection down on purpose.
    }
  }

  private parseFrame(frame: string): void {
    const message: SseMessage = { event: 'message', data: '' };
    let sawField = false;
    for (const line of frame.split('\n')) {
      if (line.startsWith(':') || line === '') {
        continue; // heartbeat comment
      }
      sawField = true;
      if (line.startsWith('event: ')) {
        message.event = line.slice(7);
      } else if (line.startsWith('id: ')) {
        message.id = line.slice(4);
      } else if (line.startsWith('data: ')) {
        message.data = line.slice(6);
      }
    }
    // retry:-only frames and pure comments are not app messages.
    if (sawField && (message.data !== '' || message.id !== undefined)) {
      this.messages.push(message);
    }
  }

  async waitFor(predicate: (messages: SseMessage[]) => boolean, timeoutMs = 15_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate(this.messages)) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `timed out waiting for SSE condition; got ${JSON.stringify(this.messages, null, 2)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  deltas(): LiveDelta[] {
    return this.messages
      .filter((message) => message.event === 'delta')
      .map((message) => JSON.parse(message.data) as LiveDelta);
  }
}

async function subscribe(cursor: string, signal: AbortSignal): Promise<Response> {
  const { GET } = await import('../app/api/traces/[traceId]/live/route');
  return GET(new Request(`http://test/api/traces/${TRACE_ID}/live?cursor=${cursor}`, { signal }), {
    params: Promise.resolve({ traceId: TRACE_ID }),
  });
}

/** Reconnect-style subscribe: cursor rides the Last-Event-ID header. */
async function resubscribe(lastEventId: string, signal: AbortSignal): Promise<Response> {
  const { GET } = await import('../app/api/traces/[traceId]/live/route');
  return GET(
    new Request(`http://test/api/traces/${TRACE_ID}/live`, {
      signal,
      headers: { 'last-event-id': lastEventId },
    }),
    { params: Promise.resolve({ traceId: TRACE_ID }) },
  );
}

run('live SSE channel (integration)', () => {
  const ch = createClient({ url: CH_URL, database: 'tracebloom' });

  beforeAll(() => {
    process.env.CLICKHOUSE_URL = CH_URL;
  });

  afterAll(async () => {
    await ch.close();
  });

  async function insertSpans(rows: Record<string, unknown>[]): Promise<void> {
    await ch.insert({ table: 'tracebloom.spans', format: 'JSONEachRow', values: rows });
  }

  it('streams inserted spans/evals in order; reconnect resumes with no gaps and no dupes', async () => {
    // Wave 1 lands BEFORE anyone subscribes: a child whose parent is open.
    await insertSpans([spanRow(CHAT, ROOT, 'chat gpt-4o', 10)]);

    const abort1 = new AbortController();
    const response = await subscribe('s0e0', abort1.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader1 = new SseReader(response);

    // The subscriber's first delta catches it up to wave 1.
    await reader1.waitFor((m) => m.some((msg) => msg.event === 'delta'));

    // Wave 2 lands WHILE subscribed: a tool span + an eval on the chat span.
    await insertSpans([spanRow(TOOL, ROOT, 'execute_tool web.search', 200)]);
    await ch.insert({
      table: 'tracebloom.eval_results',
      format: 'JSONEachRow',
      values: [evalRow(CHAT)],
    });
    await reader1.waitFor((m) => {
      const deltas = m
        .filter((msg) => msg.event === 'delta')
        .map((msg) => JSON.parse(msg.data) as LiveDelta);
      return (
        deltas.some((d) => d.spans.some((s) => s.spanId === TOOL)) &&
        deltas.some((d) => d.evals.length > 0)
      );
    });

    // Event ids (cursors) are monotonically non-decreasing.
    const ids = reader1.messages
      .filter((m) => m.event === 'delta' && m.id)
      .map((m) => m.id as string);
    const parsed = ids.map((id) => {
      const match = /^s(\d+)e(\d+)$/.exec(id);
      expect(match).not.toBeNull();
      return { s: Number(match?.[1]), e: Number(match?.[2]) };
    });
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]!.s).toBeGreaterThanOrEqual(parsed[i - 1]!.s);
      expect(parsed[i]!.e).toBeGreaterThanOrEqual(parsed[i - 1]!.e);
    }

    // Disconnect (client abort): the poller must fully tear down.
    const lastEventId = ids.at(-1);
    expect(lastEventId).toBeDefined();
    abort1.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getLiveBroker().stats()).toMatchObject({ pollers: 0, subscribers: 0 });

    // Wave 3 lands while NOBODY is subscribed (the reconnect gap).
    await insertSpans([spanRow(LATE, ROOT, 'draft answer', 400)]);

    // Reconnect exactly like EventSource does: Last-Event-ID header.
    const abort2 = new AbortController();
    const reader2 = new SseReader(await resubscribe(lastEventId as string, abort2.signal));
    await reader2.waitFor((m) =>
      m.some(
        (msg) =>
          msg.event === 'delta' &&
          (JSON.parse(msg.data) as LiveDelta).spans.some((s) => s.spanId === LATE),
      ),
    );
    abort2.abort();

    // Fold EVERY delta from both connections through the client merge: every
    // seeded span exactly once (no gaps, no dupes), the eval attached.
    let state = seedLiveState({
      traceId: TRACE_ID,
      anchorStartNs: '0',
      spans: [],
      evalResults: [],
      cursor: { spanMs: 0, evalMs: 0 },
      rootSeen: false,
    });
    for (const delta of [...reader1.deltas(), ...reader2.deltas()]) {
      state = applyDelta(state, delta);
    }
    expect([...state.spans.keys()].sort()).toEqual([CHAT, TOOL, LATE].sort());
    expect(state.evals.size).toBe(1);
    expect(state.rootSeen).toBe(false); // the root never landed
  }, 30_000);

  it('shares one poller across concurrent subscribers and keeps ingest flowing', async () => {
    const aborts = [new AbortController(), new AbortController(), new AbortController()];
    const readers: SseReader[] = [];
    for (const controller of aborts) {
      readers.push(new SseReader(await subscribe('s0e0', controller.signal)));
    }

    // Bounded fan-out: three connections, ONE poller.
    expect(getLiveBroker().stats()).toMatchObject({ pollers: 1, subscribers: 3 });

    // Ingest keeps flowing while all three are attached: the root lands and
    // every subscriber sees it (each already caught up on the older spans).
    await insertSpans([spanRow(ROOT, '', 'invoke_agent researcher', 0)]);
    for (const reader of readers) {
      await reader.waitFor((m) =>
        m.some(
          (msg) =>
            msg.event === 'delta' &&
            (JSON.parse(msg.data) as LiveDelta).spans.some((s) => s.spanId === ROOT),
        ),
      );
    }

    for (const controller of aborts) {
      controller.abort();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getLiveBroker().stats()).toMatchObject({ pollers: 0, subscribers: 0 });
  }, 30_000);

  it('rejects malformed cursors and invalid trace ids up front', async () => {
    const { GET } = await import('../app/api/traces/[traceId]/live/route');
    const bad = await GET(new Request(`http://test/api/traces/${TRACE_ID}/live?cursor=nope`), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });
    expect(bad.status).toBe(400);

    const invalid = await GET(new Request('http://test/api/traces/zzz/live?cursor=s0e0'), {
      params: Promise.resolve({ traceId: 'zzz' }),
    });
    expect(invalid.status).toBe(400);

    const missing = await GET(new Request(`http://test/api/traces/${TRACE_ID}/live`), {
      params: Promise.resolve({ traceId: TRACE_ID }),
    });
    expect(missing.status).toBe(400);
  });
});
