/**
 * Runnable example: a Vercel AI SDK researcher agent captured by TraceBloom.
 *
 * `createAISDKTelemetry()` plugs into the AI SDK's native telemetry hook, so a
 * real `generateText` tool loop becomes a gen_ai trace, the run, each step,
 * every model call and tool execution: with cost from the shared pricing map
 * and content as span events. The model is a scripted mock (no API key, no
 * network); the search tool fails once and is retried, and the final draft
 * refuses so the sample `no-refusal` eval flags it.
 *
 * Prerequisites: collector + ClickHouse + dashboard up (from the repo root):
 *
 *     pnpm stack:up
 *     pnpm --filter @tracebloom/dashboard dev
 *
 * Run it:
 *
 *     pnpm --filter @tracebloom/examples vercel
 */

import { createAISDKTelemetry, init, shutdown } from '@tracebloom/sdk';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const MODEL = 'gpt-4o-2024-08-06';
const DASHBOARD_URL = process.env.TRACEBLOOM_DASHBOARD_URL ?? 'http://localhost:3000';

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

/** Scripted model: request search, retry after its failure, then refuse. */
function researcherModel(): MockLanguageModelV3 {
  let call = 0;
  const toolCall = (id: string) => ({
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: id,
        toolName: 'webSearch',
        input: '{"query":"otel genai agents"}',
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: usage(130, 20),
    response: { id: `resp-${id}`, modelId: MODEL },
    warnings: [],
  });
  return new MockLanguageModelV3({
    modelId: MODEL,
    provider: 'openai',
    doGenerate: async () => {
      call += 1;
      if (call === 1) return toolCall('call-1');
      if (call === 2) return toolCall('call-2'); // retry after the tool error
      return {
        content: [
          {
            type: 'text' as const,
            text: 'I cannot draft a confident answer: the fetched sources conflict and I could not verify the key claims.',
          },
        ],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: usage(420, 52),
        response: { id: 'resp-final', modelId: MODEL },
        warnings: [],
      };
    },
  });
}

async function main(): Promise<void> {
  init({ serviceName: 'vercel-example', captureContent: true });

  let searchAttempts = 0;
  const result = await generateText({
    model: researcherModel(),
    stopWhen: stepCountIs(4),
    prompt: 'how do teams monitor LLM agents in production?',
    tools: {
      webSearch: tool({
        description: 'Search the public web for recent, citable sources',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          searchAttempts += 1;
          // First attempt fails transiently; the model sees the error and retries.
          if (searchAttempts === 1) {
            throw new Error('search provider returned 429 (rate limited)');
          }
          return `results for "${query}": [tracebloom.dev/docs, github.com/open-telemetry/semantic-conventions]`;
        },
      }),
    },
    telemetry: {
      functionId: 'researcher',
      integrations: [
        createAISDKTelemetry({ tag: { promptVersion: 'v1', promptName: 'research' } }),
      ],
    },
  });

  console.log('agent said:', `${result.text.slice(0, 80)}…`);
  await shutdown(); // flush the exporter
  console.log(`\n▶ Open ${DASHBOARD_URL}/traces and click the newest 'vercel-example' trace.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
