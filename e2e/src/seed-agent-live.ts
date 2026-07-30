/**
 * Slow-motion agent for the LIVE trace demo (M5): the same researcher agent
 * as seed-agent.ts: plan, tool failure + retry, parallel fetches, draft,
 * sub-agent handoff, but stretched to ~40s of wall clock, with span export
 * tuned for low latency (OTEL_BSP_SCHEDULE_DELAY=200). It prints the trace
 * URL FIRST: open it in the dashboard while the agent runs and watch the
 * tree/waterfall grow, pending parents fill in, an error flip to a retry,
 * and: if you kick off `pnpm eval:run` right after, eval scores pop in.
 *
 * Requires the stack (pnpm stack:up) and the dashboard (pnpm --filter
 * @tracebloom/dashboard dev) to be running.
 */

// Must be set before the SDK constructs its BatchSpanProcessor: spans then
// export ~200ms after ending instead of the default 5s, so "step done" and
// "span on screen" feel simultaneous (collector flush ~1s + poll ≤0.8s).
process.env.OTEL_BSP_SCHEDULE_DELAY ??= '200';

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@clickhouse/client';
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  init,
  instrumentOpenAI,
  type OpenAILike,
  shutdown,
  withAgentSpan,
  withToolSpan,
} from '@tracebloom/sdk';

const COLLECTOR_ENDPOINT = process.env.TRACEBLOOM_ENDPOINT ?? 'http://localhost:4318';
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? 'tracebloom';
const DASHBOARD_URL = process.env.TRACEBLOOM_DASHBOARD_URL ?? 'http://localhost:3000';
const SERVICE_NAME = 'agent-demo-live';
const EXPECTED_SPANS = 9;

/** Scale every pause (e.g. TRACEBLOOM_LIVE_SCALE=0.2 for a quick dry run). */
const SCALE = Number(process.env.TRACEBLOOM_LIVE_SCALE ?? '1') || 1;
const pause = (ms: number) => sleep(ms * SCALE);

interface CannedReply {
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  delayMs: number;
}

const REPLIES: Record<string, CannedReply> = {
  plan: {
    model: 'gpt-4o-2024-08-06',
    content:
      'Plan: (1) search the web for recent TraceBloom coverage, (2) fetch the two most relevant pages, (3) draft an answer with citations, (4) hand off to the summarizer.',
    inputTokens: 138,
    outputTokens: 61,
    delayMs: 4_000,
  },
  draft: {
    model: 'gpt-4o-2024-08-06',
    content:
      'Draft: TraceBloom is an open-source observability and evaluation layer for LLM agents. I cannot verify the funding rumor from the sources fetched, so it is omitted.',
    inputTokens: 512,
    outputTokens: 74,
    delayMs: 6_000,
  },
  summarize: {
    model: 'gpt-4o-mini',
    content:
      'TraceBloom: open-source, OTel-native tracing + evals for LLM agents; self-hostable; evaluation engine scores captured traffic for regressions.',
    inputTokens: 96,
    outputTokens: 38,
    delayMs: 3_500,
  },
};

/** Mock OpenAI-shaped client: canned replies keyed by the last user message. */
function mockOpenAI(): OpenAILike {
  return {
    chat: {
      completions: {
        create: async (params: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
          const last = params.messages.at(-1)?.content;
          const key = typeof last === 'string' ? (last.split(':')[0] ?? '') : '';
          const reply = REPLIES[key] ?? REPLIES.plan;
          assert.ok(reply, 'mock reply must exist');
          await pause(reply.delayMs);
          return {
            id: `chatcmpl-${key}-${Date.now().toString(36)}`,
            model: reply.model,
            choices: [
              { finish_reason: 'stop', message: { role: 'assistant', content: reply.content } },
            ],
            usage: {
              prompt_tokens: reply.inputTokens,
              completion_tokens: reply.outputTokens,
              total_tokens: reply.inputTokens + reply.outputTokens,
            },
          };
        },
      },
    },
  };
}

async function flakySearch(attempt: number): Promise<string> {
  await pause(attempt === 1 ? 2_500 : 3_000);
  if (attempt === 1) {
    throw new Error('rate limited (429) from search provider');
  }
  return 'results: [tracebloom.dev, github.com/tracebloom]';
}

function step(message: string): void {
  console.log(`[seed-agent-live] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function main(): Promise<void> {
  console.log(`[seed-agent-live] collector=${COLLECTOR_ENDPOINT} service=${SERVICE_NAME}`);
  init({ endpoint: COLLECTOR_ENDPOINT, serviceName: SERVICE_NAME, captureContent: true });
  const openai = instrumentOpenAI(mockOpenAI(), { promptVersion: 'v2', promptName: 'research' });

  let traceId = '';
  await withAgentSpan({ name: 'researcher', agentId: 'agent-researcher-1' }, async (root) => {
    traceId = root.spanContext().traceId;
    console.log('');
    console.log('  ┌──────────────────────────────────── WATCH IT LIVE ─┐');
    console.log(`     ${DASHBOARD_URL}/traces/${traceId}`);
    console.log('  └─ open it NOW — the agent runs for ~40 seconds ─────┘');
    console.log('');
    step('agent started; giving you 6s to open the viewer…');
    await pause(6_000);

    // 1. Plan with an LLM call (~4s: watch the first span pop in after it).
    step('planning (LLM call, ~4s)…');
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'plan: research TraceBloom and summarize it' }],
    });

    // 2. Tool call that fails once and is retried: the status flips red,
    //    then the retry lands beside it (one span per attempt).
    for (let attempt = 1; ; attempt++) {
      step(attempt === 1 ? 'searching the web (will fail)…' : 'retrying the search…');
      try {
        await withToolSpan(
          {
            name: 'web.search',
            callId: 'call-search-1',
            description: 'Search the public web',
            retryAttempt: attempt,
          },
          () => flakySearch(attempt),
        );
        break;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
        step(`tool failed (attempt ${attempt}): ${(error as Error).message}`);
      }
    }

    // 3. Two parallel page fetches: overlapping bars growing side by side.
    step('fetching two pages in parallel…');
    await Promise.all([
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-1' }, () => pause(4_500)),
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-2' }, () => pause(6_500)),
    ]);

    // 4. Draft the answer (~6s; this output trips the no-refusal eval).
    step('drafting the answer (LLM call, ~6s)…');
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'draft: write the answer from the fetched sources' }],
    });

    // 5. Delegate to a sub-agent: a nested pending parent while it runs.
    step('handing off to the summarizer sub-agent…');
    await withAgentSpan({ name: 'summarizer', agentId: 'agent-summarizer-1' }, async () => {
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'summarize: condense the draft to two sentences' }],
      });
    });
    step('root completing — the LIVE badge flips to OK when it lands.');
  });

  await shutdown();
  step(`trace ${traceId} exported; waiting for ClickHouse…`);

  const ch = createClient({ url: CLICKHOUSE_URL, database: CLICKHOUSE_DATABASE });
  let landed = 0;
  for (let poll = 0; poll < 40; poll++) {
    const rs = await ch.query({
      query: 'SELECT count() AS c FROM tracebloom.spans WHERE trace_id = {tid:String}',
      query_params: { tid: traceId },
      format: 'JSONEachRow',
    });
    landed = Number((await rs.json<{ c: string }>())[0]?.c ?? 0);
    if (landed >= EXPECTED_SPANS) {
      break;
    }
    await sleep(500);
  }
  await ch.close();
  assert.equal(landed, EXPECTED_SPANS, `expected ${EXPECTED_SPANS} spans to land, got ${landed}`);

  console.log('');
  step(`✅ ${landed} spans landed for trace ${traceId}`);
  step('now score it while the page is still streaming:');
  step('  pnpm eval:seed && pnpm eval:run   ← chips pop onto the spans');
  step(`or replay the arrival: ${DASHBOARD_URL}/traces/${traceId} → "▶ Replay arrival"`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[seed-agent-live] ❌ failed:', error);
    process.exit(1);
  });
