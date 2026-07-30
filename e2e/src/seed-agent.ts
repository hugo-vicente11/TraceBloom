/**
 * Seed a realistic multi-step agent trace for the trace viewer demo, the
 * LLM provider is mocked (no API key): a researcher agent that plans with an
 * LLM call, hits a tool failure + retry, fans out two parallel fetches,
 * drafts an answer, and delegates to a sub-agent. Content capture is ON so
 * the span detail panel shows prompts/responses; one output deliberately
 * contains "I cannot", so the sample `no-refusal` eval (pnpm eval:seed +
 * eval:run) fails that span and the score shows up red in the viewer.
 *
 * Requires the collector + ClickHouse to be up (pnpm stack:up).
 */

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
const SERVICE_NAME = 'agent-demo';
const EXPECTED_SPANS = 9;

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
    delayMs: 160,
  },
  draft: {
    model: 'gpt-4o-2024-08-06',
    content:
      'Draft: TraceBloom is an open-source observability and evaluation layer for LLM agents. I cannot verify the funding rumor from the sources fetched, so it is omitted.',
    inputTokens: 512,
    outputTokens: 74,
    delayMs: 210,
  },
  summarize: {
    model: 'gpt-4o-mini',
    content:
      'TraceBloom: open-source, OTel-native tracing + evals for LLM agents; self-hostable; evaluation engine scores captured traffic for regressions.',
    inputTokens: 96,
    outputTokens: 38,
    delayMs: 120,
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
          await sleep(reply.delayMs);
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
  await sleep(attempt === 1 ? 90 : 130);
  if (attempt === 1) {
    throw new Error('rate limited (429) from search provider');
  }
  return 'results: [tracebloom.dev, github.com/tracebloom]';
}

async function main(): Promise<void> {
  console.log(`[seed-agent] collector=${COLLECTOR_ENDPOINT} service=${SERVICE_NAME}`);
  init({ endpoint: COLLECTOR_ENDPOINT, serviceName: SERVICE_NAME, captureContent: true });
  const openai = instrumentOpenAI(mockOpenAI(), { promptVersion: 'v2', promptName: 'research' });

  let traceId = '';
  await withAgentSpan({ name: 'researcher', agentId: 'agent-researcher-1' }, async (root) => {
    traceId = root.spanContext().traceId;

    // 1. Plan with an LLM call.
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'plan: research TraceBloom and summarize it' }],
    });

    // 2. Tool call that fails once and is retried (one span per attempt).
    for (let attempt = 1; ; attempt++) {
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
        console.log(`[seed-agent] tool failed (attempt ${attempt}), retrying:`, error);
      }
    }

    // 3. Two parallel page fetches: overlapping bars in the waterfall.
    await Promise.all([
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-1' }, () => sleep(150)),
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-2' }, () => sleep(100)),
    ]);

    // 4. Draft the answer (this output trips the sample no-refusal eval).
    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'draft: write the answer from the fetched sources' }],
    });

    // 5. Delegate to a sub-agent for the final summary.
    await withAgentSpan({ name: 'summarizer', agentId: 'agent-summarizer-1' }, async () => {
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'summarize: condense the draft to two sentences' }],
      });
    });
  });

  await shutdown();
  console.log(`[seed-agent] trace ${traceId} exported; waiting for ClickHouse...`);

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

  console.log(`[seed-agent] ✅ ${landed} spans landed for trace ${traceId}`);
  console.log('[seed-agent] open the waterfall viewer:');
  console.log(`[seed-agent]   ${DASHBOARD_URL}/traces/${traceId}`);
  console.log(
    '[seed-agent] score it: pnpm eval:seed && pnpm eval:run   (then reload the trace page)',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[seed-agent] ❌ failed:', error);
    process.exit(1);
  });
