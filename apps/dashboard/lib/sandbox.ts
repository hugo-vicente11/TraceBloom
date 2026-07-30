/**
 * The "try it" sandbox: a bounded, mock-LLM **Vercel AI SDK** researcher agent
 * run in-process with the real @tracebloom/sdk, exporting through the internal
 * collector so the M5 live stream renders it exactly like any instrumented app
 * (DECISIONS.md D27). M7 points the sandbox at a real framework: the run is a
 * genuine `generateText` tool loop captured by `createAISDKTelemetry`, so a
 * visitor watches an actual framework agent: plan, a tool that fails and is
 * retried, a refusing draft: render live.
 *
 * Why this is safe to expose publicly:
 *  - the script is CANNED: the model is a scripted mock and no user input
 *    reaches the run, so spans (9) and wall clock (~15s) are bounded by
 *    construction; an AbortSignal force-stops the run at maxRunMs as a backstop;
 *  - the provider is a mock: no API keys exist in this process, and cost is
 *    structurally zero;
 *  - global caps: maxConcurrent simultaneous runs and a daily run budget, both
 *    enforced here (per-IP limiting lives in the route);
 *  - isolation: spans carry service_name `demo-sandbox` and variant `sandbox`;
 *    the demo reset deletes exactly that namespace.
 */

import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createAISDKTelemetry, init } from '@tracebloom/sdk';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

/** Must match apps/demo/src/corpus.ts SANDBOX_SERVICE (reset deletes by it). */
export const SANDBOX_SERVICE = 'demo-sandbox';
/** Variant tag for sandbox spans — keeps them out of the v1/v2 A/B story. */
export const SANDBOX_VARIANT = 'sandbox';
/** Model the scripted mock reports (drives cost from the shared pricing map). */
const SANDBOX_MODEL = 'gpt-4o-2024-08-06';

export interface SandboxLimits {
  /** Simultaneous sandbox runs across all visitors. */
  maxConcurrent: number;
  /** Runs per UTC day across all visitors. */
  dailyBudget: number;
  /** Watchdog: force-abort a run that somehow outlives the script. */
  maxRunMs: number;
  /** Spans one run produces. */
  spansPerRun: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  /** Simultaneous sandbox runs across all visitors. */
  maxConcurrent: 3,
  /** Runs per UTC day across all visitors (mock provider, so this bounds
   * ClickHouse rows, not spend). */
  dailyBudget: 200,
  /** Watchdog: force-abort a run that somehow outlives the script. */
  maxRunMs: 90_000,
  // invoke_agent + 3×(execute_task step) + 3×chat + 2×execute_tool (search
  // fails then retries).
  spansPerRun: 9,
};

interface SandboxState {
  active: number;
  day: string;
  runsToday: number;
  initialized: boolean;
}

// globalThis so Next dev-mode HMR cannot double-count or re-init the SDK.
const STATE_KEY = Symbol.for('tracebloom.sandbox-state');
function state(): SandboxState {
  const holder = globalThis as { [STATE_KEY]?: SandboxState };
  holder[STATE_KEY] ??= { active: 0, day: '', runsToday: 0, initialized: false };
  return holder[STATE_KEY];
}

/**
 * Registering a global tracer provider wakes Next.js's built-in OTel
 * instrumentation, which would export an HTTP-handling trace for EVERY
 * dashboard request: noise in the demo and a feedback loop (the SSE route's
 * own spans would stream into the traces it serves). This processor forwards
 * only spans created by the TraceBloom SDK tracer; everything else is dropped
 * before it can reach the exporter. (The AI SDK integration builds its spans
 * with the SDK's own tracer, so framework spans keep the allowed scope.)
 */
export class ScopeFilterSpanProcessor implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly allowedScope: string,
  ) {}

  onStart(span: SdkSpan, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name === this.allowedScope) {
      this.inner.onEnd(span);
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** The scope name of @tracebloom/sdk's tracer (see packages/sdk-ts tracer.ts). */
const SDK_SCOPE = '@tracebloom/sdk';

/**
 * Initialize the SDK once for this process (idempotent). Tests inject an
 * in-memory span processor; production exports OTLP to TRACEBLOOM_ENDPOINT
 * through the scope filter above.
 */
export function ensureSandboxSdk(options?: { spanProcessor?: SpanProcessor }): void {
  const s = state();
  if (s.initialized) {
    return;
  }
  const endpoint = (process.env.TRACEBLOOM_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '');
  const inner =
    options?.spanProcessor ??
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }));
  init({
    serviceName: SANDBOX_SERVICE,
    captureContent: true,
    spanProcessor: new ScopeFilterSpanProcessor(inner, SDK_SCOPE),
  });
  s.initialized = true;
}

interface Scenario {
  brief: string;
  /** The final draft — always refuses ("I cannot …"), the demo's eval-chip moment. */
  refusal: string;
}

/** Small pool so repeat runs read differently. The draft ALWAYS refuses — that
 * is the demo moment: the `no-refusal` eval chip flips red on the span in front
 * of the viewer when the runner scores it seconds later. */
const SCENARIOS: Scenario[] = [
  {
    brief: 'research how teams monitor LLM agents in production',
    refusal:
      'I cannot draft this comparison confidently from the fetched pages, so I am declining to answer.',
  },
  {
    brief: 'compare open-source eval frameworks for agent pipelines',
    refusal:
      'I cannot verify the benchmark claims in the fetched material, so I will not produce the comparison.',
  },
  {
    brief: 'summarize this week’s OpenTelemetry GenAI spec changes',
    refusal:
      'I cannot reconcile the fetched changelog with the discussion thread, so I am not drafting a summary.',
  },
];

/** V3 provider usage shape (total + token-detail sub-objects). */
function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

class SandboxAborted extends Error {
  constructor() {
    super('sandbox run exceeded its time budget');
    this.name = 'SandboxAborted';
  }
}

/**
 * Scripted model: request web_search (step 0), request it again after the
 * first attempt fails (step 1, the retry), then produce the refusing draft
 * (step 2). Each response is paced so the run streams into the viewer.
 */
function sandboxModel(
  scenario: Scenario,
  pace: (ms: number) => Promise<void>,
): MockLanguageModelV3 {
  let call = 0;
  const searchCall = (id: string) => ({
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: id,
        toolName: 'web_search',
        input: '{"query":"agent observability"}',
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: usage(132, 24),
    response: { id: `chatcmpl-${id}`, modelId: SANDBOX_MODEL },
    warnings: [],
  });
  return new MockLanguageModelV3({
    modelId: SANDBOX_MODEL,
    provider: 'openai',
    doGenerate: async () => {
      call += 1;
      await pace(2_400);
      if (call === 1) return searchCall('call-search-1');
      if (call === 2) return searchCall('call-search-2');
      return {
        content: [{ type: 'text' as const, text: scenario.refusal }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: usage(498, 64),
        response: { id: 'chatcmpl-draft', modelId: SANDBOX_MODEL },
        warnings: [],
      };
    },
  });
}

export type StartResult =
  | { ok: true; traceId: string; done: Promise<void> }
  | { ok: false; reason: 'concurrency' | 'budget' };

export interface StartOptions {
  /** Scale every pause (tests use ~0). */
  paceScale?: number;
  /** Override limits (tests). */
  limits?: Partial<SandboxLimits>;
  /** Test hook: SDK span processor for ensureSandboxSdk. */
  spanProcessor?: SpanProcessor;
  now?: () => number;
}

/**
 * Start one sandbox run. Resolves with the trace id as soon as the agent's root
 * span exists (the caller responds immediately; the run continues in-process
 * and streams live). `done` settles when the run finishes, tests await it; the
 * route fire-and-forgets it.
 */
export async function startSandboxRun(options: StartOptions = {}): Promise<StartResult> {
  const limits = { ...SANDBOX_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const s = state();

  const today = new Date(now()).toISOString().slice(0, 10);
  if (s.day !== today) {
    s.day = today;
    s.runsToday = 0;
  }
  if (s.active >= limits.maxConcurrent) {
    return { ok: false, reason: 'concurrency' };
  }
  if (s.runsToday >= limits.dailyBudget) {
    return { ok: false, reason: 'budget' };
  }
  s.active += 1;
  s.runsToday += 1;

  ensureSandboxSdk({ spanProcessor: options.spanProcessor });

  const scale = options.paceScale ?? (Number(process.env.TRACEBLOOM_SANDBOX_SCALE || '1') || 1);
  // Backstop watchdog: abort the run if it somehow outlives maxRunMs.
  const controller = new AbortController();
  const deadline = now() + limits.maxRunMs;
  const watchdog = setTimeout(() => controller.abort(new SandboxAborted()), limits.maxRunMs);

  // Chunked sleep so the watchdog has ~250ms resolution regardless of step size.
  const pace = async (ms: number): Promise<void> => {
    let remaining = ms * scale;
    while (remaining > 0) {
      if (controller.signal.aborted || now() > deadline) {
        throw new SandboxAborted();
      }
      const slice = Math.min(remaining, 250);
      await new Promise((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
    if (controller.signal.aborted || now() > deadline) {
      throw new SandboxAborted();
    }
  };

  const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)] ?? SCENARIOS[0];
  if (!scenario) {
    s.active -= 1;
    clearTimeout(watchdog);
    throw new Error('sandbox scenario pool is empty');
  }

  let searchAttempts = 0;
  const webSearch = tool({
    description: 'Search the public web',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => {
      searchAttempts += 1;
      await pace(searchAttempts === 1 ? 2_000 : 2_500);
      if (searchAttempts === 1) {
        // The scripted failure: the AI SDK feeds this back to the model, which
        // retries: the errored span and its retry sit side by side.
        throw new Error('rate limited (429) from search provider');
      }
      return 'results: [tracebloom.dev, github.com/tracebloom]';
    },
  });

  let resolveTraceId: (id: string) => void = () => {};
  const traceIdReady = new Promise<string>((resolve) => {
    resolveTraceId = resolve;
  });

  const integration = createAISDKTelemetry({
    tag: { promptVersion: SANDBOX_VARIANT, promptName: 'research' },
    onRunStart: ({ traceId }) => resolveTraceId(traceId),
  });

  const done = (async () => {
    try {
      // Detach from the HTTP request's trace context: the agent run must be its
      // OWN trace root, not a child of Next's POST /api/try-it span.
      await context.with(ROOT_CONTEXT, () =>
        generateText({
          model: sandboxModel(scenario, pace),
          tools: { web_search: webSearch },
          stopWhen: stepCountIs(4),
          maxRetries: 0,
          abortSignal: controller.signal,
          prompt: scenario.brief,
          telemetry: { functionId: 'researcher', integrations: [integration] },
        }),
      );
    } catch (error) {
      // Aborts and the scripted tool failure end the trace with an ERROR span —
      // that is legitimate demo output, not a server fault.
      if (!(error instanceof SandboxAborted) && !controller.signal.aborted) {
        console.error('[sandbox] run failed:', error);
      }
    } finally {
      clearTimeout(watchdog);
      s.active -= 1;
    }
  })();

  const traceId = await Promise.race([
    traceIdReady,
    done.then(() => ''), // if the run failed before any span, don't hang.
  ]);
  if (!traceId) {
    return { ok: false, reason: 'concurrency' };
  }
  return { ok: true, traceId, done };
}

/** Introspection for the route and tests. */
export function sandboxStats(): { active: number; runsToday: number } {
  const s = state();
  return { active: s.active, runsToday: s.runsToday };
}

/** Test-only: clear counters between test cases. */
export function resetSandboxStateForTests(): void {
  const s = state();
  s.active = 0;
  s.day = '';
  s.runsToday = 0;
}
