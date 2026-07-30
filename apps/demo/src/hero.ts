/**
 * The "hero" trace: one fresh researcher run emitted through the REAL
 * pipeline (SDK -> collector -> ClickHouse) at seed time, so the top of the
 * demo trace list is minutes old and provably produced by the same path any
 * instrumented app would use. Runs the v2 prompt with a refusal draft, so the
 * live eval runner scores it and pins a red `no-refusal` chip on it shortly
 * after seeding.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { ClickHouseClient } from '@clickhouse/client';
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
import { DEMO_SERVICE } from './corpus.js';
import type { DemoConfig } from './env.js';

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
      'Plan: (1) search for recent coverage of open-source LLM observability, (2) fetch the two most relevant pages, (3) draft an answer with citations, (4) hand off to the summarizer.',
    inputTokens: 141,
    outputTokens: 63,
    delayMs: 150,
  },
  draft: {
    model: 'gpt-4o-2024-08-06',
    content:
      'Draft: I cannot verify enough of the fetched material to draft this comparison, so I am declining to answer rather than guessing.',
    inputTokens: 508,
    outputTokens: 71,
    delayMs: 200,
  },
  summarize: {
    model: 'gpt-4o-mini',
    content:
      'The researcher declined to draft the comparison, citing insufficient verifiable sources.',
    inputTokens: 92,
    outputTokens: 28,
    delayMs: 110,
  },
};

function mockOpenAI(): OpenAILike {
  return {
    chat: {
      completions: {
        create: async (params: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
          const last = params.messages.at(-1)?.content;
          const key = typeof last === 'string' ? (last.split(':')[0] ?? '') : '';
          const reply = REPLIES[key] ?? REPLIES.plan;
          if (!reply) {
            throw new Error('mock reply missing');
          }
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

/** Emit the hero trace and wait for it to land. Returns its trace id. */
export async function runHeroTrace(config: DemoConfig, ch: ClickHouseClient): Promise<string> {
  init({
    endpoint: config.collectorEndpoint,
    serviceName: DEMO_SERVICE,
    captureContent: true,
  });
  const openai = instrumentOpenAI(mockOpenAI(), { promptVersion: 'v2', promptName: 'research' });

  let traceId = '';
  await withAgentSpan({ name: 'researcher', agentId: 'agent-researcher-1' }, async (root) => {
    traceId = root.spanContext().traceId;

    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'plan: research open-source LLM observability tools' }],
    });

    for (let attempt = 1; ; attempt++) {
      try {
        await withToolSpan(
          {
            name: 'web.search',
            callId: 'call-search-1',
            description: 'Search the public web',
            retryAttempt: attempt,
          },
          async () => {
            await sleep(attempt === 1 ? 80 : 120);
            if (attempt === 1) {
              throw new Error('rate limited (429) from search provider');
            }
            return 'results: [tracebloom.dev, github.com/tracebloom]';
          },
        );
        break;
      } catch (error) {
        if (attempt >= 2) {
          throw error;
        }
      }
    }

    await Promise.all([
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-1' }, () => sleep(140)),
      withToolSpan({ name: 'web.fetch', callId: 'call-fetch-2' }, () => sleep(95)),
    ]);

    await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'draft: write the answer from the fetched sources' }],
    });

    await withAgentSpan({ name: 'summarizer', agentId: 'agent-summarizer-1' }, async () => {
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'summarize: condense the draft to two sentences' }],
      });
    });
  });

  await shutdown();

  let landed = 0;
  for (let poll = 0; poll < 40; poll++) {
    const rs = await ch.query({
      query: 'SELECT count() AS c FROM tracebloom.spans WHERE trace_id = {tid:String}',
      query_params: { tid: traceId },
      format: 'JSONEachRow',
    });
    landed = Number((await rs.json<{ c: string }>())[0]?.c ?? 0);
    if (landed >= EXPECTED_SPANS) {
      return traceId;
    }
    await sleep(500);
  }
  throw new Error(
    `hero trace: expected ${EXPECTED_SPANS} spans to land, got ${landed} (trace ${traceId})`,
  );
}
