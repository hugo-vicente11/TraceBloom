/**
 * Pure generator for the curated demo corpus: ~52 multi-step researcher-agent
 * traces spread over the trailing week, split across prompt variants v1
 * (baseline) and v2 (a "worse prompt" rolled out ~36h ago), plus the judge
 * scores and rationales for every chat span.
 *
 * The rows mirror EXACTLY what the real pipeline produces, same span names,
 * kinds, gen_ai.* attributes, content events and cost math as
 * @tracebloom/sdk -> collector, so the dashboard cannot tell seeded data from
 * captured data. The refusal rate of v2's drafts is fixed by count (not by
 * probability), so the sample `no-refusal` eval's pass rate provably drops
 * beyond the runner's regression threshold in the last-24h window and the REAL
 * regression detector flags v2 organically.
 *
 * Everything is a deterministic function of (nowMs, seed).
 */

import { computeCost, DEFAULT_PRICING } from '@tracebloom/sdk';
import { chance, hexId, mulberry32, pick, type Rng, randFloat, randInt } from './rng.js';

/** Every demo span carries this service name; reset deletes by it. */
export const DEMO_SERVICE = 'demo-researcher';
/** Sandbox (try-it) runs use this service name; reset deletes it too. */
export const SANDBOX_SERVICE = 'demo-sandbox';

export const DEMO_VARIANTS = { baseline: 'v1', regressed: 'v2' } as const;

/** JSONEachRow shape for tracebloom.spans (see infra/clickhouse 0002). */
export interface DemoSpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  duration_ns: number;
  status_code: string;
  status_message: string;
  service_name: string;
  scope_name: string;
  operation_name: string;
  provider: string;
  request_model: string;
  response_model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  response_id: string;
  finish_reasons: string[];
  attributes_json: string;
  resource_attributes_json: string;
  ingested_at: string;
}

/** JSONEachRow shape for tracebloom.span_events (see 0003). */
export interface DemoEventRow {
  trace_id: string;
  span_id: string;
  event_index: number;
  name: string;
  timestamp: string;
  body: string;
  attributes_json: string;
  ingested_at: string;
}

export type ChatRole = 'plan' | 'draft' | 'summarize';

/** A chat span plus its reconstructed I/O — the input to eval-result seeding. */
export interface CorpusChatSpan {
  row: DemoSpanRow;
  role: ChatRole;
  input: string;
  output: string;
  /** True when the output is one of the refusal drafts (trips `no-refusal`). */
  refusal: boolean;
  variant: string;
}

export interface DemoTrace {
  traceId: string;
  variant: string;
  startMs: number;
  /** Both search attempts failed: truncated run, root span is an ERROR. */
  hardFailure: boolean;
  /** First search attempt failed and was retried. */
  retried: boolean;
  spans: DemoSpanRow[];
  events: DemoEventRow[];
  chatSpans: CorpusChatSpan[];
}

export interface Corpus {
  traces: DemoTrace[];
  spans: DemoSpanRow[];
  events: DemoEventRow[];
  chatSpans: CorpusChatSpan[];
}

/** Format a unix-ms timestamp the way ClickHouse parses DateTime64 ('UTC'). */
export function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

interface Topic {
  brief: string;
  plan: string;
  draft: string;
  summary: string;
}

const TOPICS: Topic[] = [
  {
    brief: 'Compare pgvector and dedicated vector databases for a mid-size RAG workload.',
    plan: 'Plan: (1) search for recent pgvector vs dedicated-store benchmarks, (2) fetch the two most credible write-ups, (3) draft a comparison with citations, (4) hand off to the summarizer.',
    draft:
      'Draft: For workloads under ~50M vectors, pgvector with HNSW keeps operational overhead low and query latency within budget; dedicated stores win past that scale or with heavy metadata filtering. Sources: fetched benchmark posts.',
    summary:
      'pgvector suffices below ~50M vectors; dedicated vector stores pay off at larger scale or filter-heavy workloads.',
  },
  {
    brief: 'Summarize the current state of OpenTelemetry GenAI semantic conventions.',
    plan: 'Plan: (1) search for the OTel GenAI conventions status, (2) fetch the spec and one adoption report, (3) draft a status summary, (4) hand off to the summarizer.',
    draft:
      'Draft: The gen_ai.* namespace is in development; span attributes for model, tokens and operations are stable enough for production use, while content-capture events and evaluation results are still incubating. Instrumentation libraries track the spec closely.',
    summary:
      'OTel GenAI conventions: core span attributes are usable today; content and evaluation events are still incubating.',
  },
  {
    brief: 'What broke in the checkout service deploy on Tuesday? Correlate the incident timeline.',
    plan: 'Plan: (1) search the incident tracker for the checkout deploy, (2) fetch the deploy log and the pager timeline, (3) draft a correlated timeline, (4) hand off to the summarizer.',
    draft:
      'Draft: The 14:02 deploy introduced a nil guard regression in the tax calculator; error rate crossed the alert threshold at 14:11, rollback completed 14:26. Two retries of the payment webhook masked the first symptoms.',
    summary:
      'Checkout incident: 14:02 deploy regressed the tax calculator; alerts at 14:11; rollback done by 14:26.',
  },
  {
    brief: 'Evaluate whether we should adopt speculative decoding for the support-bot models.',
    plan: 'Plan: (1) search for speculative decoding production reports, (2) fetch two engineering write-ups, (3) draft a recommendation with numbers, (4) hand off to the summarizer.',
    draft:
      'Draft: Reported speedups cluster around 1.8-2.4x for chat workloads with a small draft model; quality is unchanged when acceptance sampling is configured correctly. Recommend a two-week canary on the support bot.',
    summary:
      'Speculative decoding: ~2x latency win at unchanged quality; recommend a scoped canary on the support bot.',
  },
  {
    brief: 'Collect pricing and rate-limit changes across the major LLM providers this quarter.',
    plan: 'Plan: (1) search provider changelogs for pricing updates, (2) fetch the two most complete change lists, (3) draft a consolidated table, (4) hand off to the summarizer.',
    draft:
      'Draft: Input-token prices fell 20-40% on flagship models this quarter while rate limits doubled for paid tiers; batch APIs are now uniformly half price. Full per-provider table with sources attached.',
    summary:
      'Quarterly LLM pricing: flagship input prices down 20-40%, paid-tier rate limits roughly doubled, batch uniformly half price.',
  },
  {
    brief: 'Research how teams run evals for agentic workflows in CI.',
    plan: 'Plan: (1) search for agent-eval CI case studies, (2) fetch two detailed posts, (3) draft the common patterns, (4) hand off to the summarizer.',
    draft:
      'Draft: Teams converge on trace-based evals: record agent runs, replay them against scoring rules and LLM judges in CI, and gate merges on pass-rate deltas rather than absolute scores. Flakiness is handled by scoring distributions, not single runs.',
    summary:
      'Agent evals in CI: record traces, score replays with rules + judges, gate on pass-rate deltas.',
  },
];

/** Refusal drafts — the failure mode the v2 prompt introduces. */
const REFUSAL_DRAFTS = [
  'Draft: I cannot produce this comparison with confidence, so I will not attempt an answer here. The fetched sources may be incomplete.',
  "Draft: I'm sorry, but as an AI I cannot verify the fetched sources well enough to draft this answer.",
  'Draft: I cannot complete the requested draft: the research brief is broader than the sources I was given, and I would rather return nothing than guess.',
];

const SEARCH_ERROR = 'rate limited (429) from search provider';

interface AttrMap {
  [key: string]: string | number | boolean | string[];
}

function makeIngested(rng: Rng, endMs: number): string {
  return chDateTime(endMs + randInt(rng, 250, 500));
}

interface SpanParams {
  rng: Rng;
  traceId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  startMs: number;
  endMs: number;
  status: 'OK' | 'ERROR';
  statusMessage?: string;
  operation: string;
  attrs: AttrMap;
  provider?: string;
  requestModel?: string;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  responseId?: string;
  finishReasons?: string[];
}

function span(params: SpanParams): DemoSpanRow {
  return {
    trace_id: params.traceId,
    span_id: hexId(params.rng, 16),
    parent_span_id: params.parentSpanId,
    name: params.name,
    kind: params.kind,
    start_time: chDateTime(params.startMs),
    end_time: chDateTime(params.endMs),
    duration_ns: Math.max(0, Math.round((params.endMs - params.startMs) * 1e6)),
    status_code: params.status,
    status_message: params.statusMessage ?? '',
    service_name: DEMO_SERVICE,
    scope_name: '@tracebloom/sdk',
    operation_name: params.operation,
    provider: params.provider ?? '',
    request_model: params.requestModel ?? '',
    response_model: params.responseModel ?? '',
    input_tokens: params.inputTokens ?? 0,
    output_tokens: params.outputTokens ?? 0,
    total_tokens: (params.inputTokens ?? 0) + (params.outputTokens ?? 0),
    cost_usd: params.costUsd ?? 0,
    response_id: params.responseId ?? '',
    finish_reasons: params.finishReasons ?? [],
    attributes_json: JSON.stringify(params.attrs),
    resource_attributes_json: JSON.stringify({ 'service.name': DEMO_SERVICE }),
    ingested_at: makeIngested(params.rng, params.endMs),
  };
}

function contentEvents(
  rng: Rng,
  row: DemoSpanRow,
  startMs: number,
  endMs: number,
  input: string,
  output: string,
): DemoEventRow[] {
  const base = {
    trace_id: row.trace_id,
    span_id: row.span_id,
    attributes_json: '{}',
    ingested_at: makeIngested(rng, endMs),
  };
  return [
    {
      ...base,
      event_index: 0,
      name: 'gen_ai.user.message',
      timestamp: chDateTime(startMs + 3),
      body: JSON.stringify({ content: input }),
    },
    {
      ...base,
      event_index: 1,
      name: 'gen_ai.choice',
      timestamp: chDateTime(endMs - 3),
      body: JSON.stringify({ index: 0, finish_reason: 'stop', content: output }),
    },
  ];
}

function exceptionEvent(rng: Rng, row: DemoSpanRow, atMs: number, message: string): DemoEventRow {
  return {
    trace_id: row.trace_id,
    span_id: row.span_id,
    event_index: 0,
    name: 'exception',
    timestamp: chDateTime(atMs),
    body: JSON.stringify({
      'exception.type': 'Error',
      'exception.message': message,
      'exception.stacktrace': `Error: ${message}\n    at flakySearch (agent/researcher.ts:88:11)\n    at withToolSpan (@tracebloom/sdk/agent.ts:52:20)`,
    }),
    attributes_json: '{}',
    ingested_at: makeIngested(rng, atMs),
  };
}

interface ChatParams {
  rng: Rng;
  traceId: string;
  parentSpanId: string;
  variant: string;
  role: ChatRole;
  startMs: number;
  durMs: number;
  requestModel: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  input: string;
  output: string;
}

function chatSpan(params: ChatParams): { row: DemoSpanRow; events: DemoEventRow[] } {
  const endMs = params.startMs + params.durMs;
  const cost = computeCost(
    params.responseModel,
    params.inputTokens,
    params.outputTokens,
    DEFAULT_PRICING,
  );
  const responseId = `chatcmpl-${params.role}-${hexId(params.rng, 10)}`;
  const attrs: AttrMap = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': params.requestModel,
    'gen_ai.prompt.version': params.variant,
    'gen_ai.prompt.name': 'research',
    'gen_ai.response.model': params.responseModel,
    'gen_ai.response.id': responseId,
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': params.inputTokens,
    'gen_ai.usage.output_tokens': params.outputTokens,
    'tracebloom.cost.input_usd': cost.inputUsd,
    'tracebloom.cost.output_usd': cost.outputUsd,
    'tracebloom.cost.total_usd': cost.totalUsd,
  };
  const row = span({
    rng: params.rng,
    traceId: params.traceId,
    parentSpanId: params.parentSpanId,
    name: `chat ${params.requestModel}`,
    kind: 'CLIENT',
    startMs: params.startMs,
    endMs,
    status: 'OK',
    operation: 'chat',
    attrs,
    provider: 'openai',
    requestModel: params.requestModel,
    responseModel: params.responseModel,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costUsd: cost.totalUsd,
    responseId,
    finishReasons: ['stop'],
  });
  return {
    row,
    events: contentEvents(params.rng, row, params.startMs, endMs, params.input, params.output),
  };
}

interface TraceSpec {
  variant: string;
  startMs: number;
  refusal: boolean;
  retried: boolean;
  hardFailure: boolean;
}

/** Build one researcher-agent trace from its spec. */
function buildTrace(rng: Rng, spec: TraceSpec): DemoTrace {
  const traceId = hexId(rng, 32);
  const topic = pick(rng, TOPICS);
  const spans: DemoSpanRow[] = [];
  const events: DemoEventRow[] = [];
  const chatSpans: CorpusChatSpan[] = [];

  const rootStart = spec.startMs;
  let cursor = rootStart + randInt(rng, 90, 160);

  // Root is appended LAST (its end time depends on the children) but its span
  // id must exist first for parenting.
  const rootSpanId = hexId(rng, 16);

  const addChat = (
    role: ChatRole,
    parent: string,
    startMs: number,
    durMs: number,
    requestModel: string,
    responseModel: string,
    tokens: { input: number; output: number },
    input: string,
    output: string,
    refusal: boolean,
  ): DemoSpanRow => {
    const { row, events: chatEvents } = chatSpan({
      rng,
      traceId,
      parentSpanId: parent,
      variant: spec.variant,
      role,
      startMs,
      durMs,
      requestModel,
      responseModel,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      input,
      output,
    });
    spans.push(row);
    events.push(...chatEvents);
    chatSpans.push({ row, role, input, output, refusal, variant: spec.variant });
    return row;
  };

  // 1. Plan.
  const planDur = randInt(rng, 900, 1700);
  addChat(
    'plan',
    rootSpanId,
    cursor,
    planDur,
    'gpt-4o',
    'gpt-4o-2024-08-06',
    { input: randInt(rng, 128, 168), output: randInt(rng, 48, 82) },
    `plan: ${topic.brief}`,
    topic.plan,
    false,
  );
  cursor += planDur + randInt(rng, 60, 120);

  // 2. web.search: one span per attempt, like a real retry loop.
  const attempts = spec.retried || spec.hardFailure ? 2 : 1;
  let lastSearchEnd = cursor;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failed = spec.hardFailure || (spec.retried && attempt === 1);
    const dur = randInt(rng, 350, 750);
    const attrs: AttrMap = {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'web.search',
      'gen_ai.tool.call.id': 'call-search-1',
      'gen_ai.tool.description': 'Search the public web',
      'tracebloom.retry.attempt': attempt,
    };
    const row = span({
      rng,
      traceId,
      parentSpanId: rootSpanId,
      name: 'execute_tool web.search',
      kind: 'INTERNAL',
      startMs: cursor,
      endMs: cursor + dur,
      status: failed ? 'ERROR' : 'OK',
      statusMessage: failed ? SEARCH_ERROR : undefined,
      operation: 'execute_tool',
      attrs,
    });
    spans.push(row);
    if (failed) {
      events.push(exceptionEvent(rng, row, cursor + dur - 5, SEARCH_ERROR));
    }
    lastSearchEnd = cursor + dur;
    cursor = lastSearchEnd + randInt(rng, 120, 220);
  }

  let rootEnd: number;
  if (spec.hardFailure) {
    // Both attempts failed: the run aborts here and the root errors out.
    rootEnd = lastSearchEnd + randInt(rng, 40, 90);
    const rootRow = span({
      rng,
      traceId,
      parentSpanId: '',
      name: 'invoke_agent researcher',
      kind: 'INTERNAL',
      startMs: rootStart,
      endMs: rootEnd,
      status: 'ERROR',
      statusMessage: SEARCH_ERROR,
      operation: 'invoke_agent',
      attrs: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'researcher',
        'gen_ai.agent.id': 'agent-researcher-1',
      },
    });
    // Overwrite the placeholder id so children reference the real root.
    rootRow.span_id = rootSpanId;
    events.push(exceptionEvent(rng, rootRow, rootEnd - 3, SEARCH_ERROR));
    spans.push(rootRow);
    return {
      traceId,
      variant: spec.variant,
      startMs: rootStart,
      hardFailure: true,
      retried: true,
      spans,
      events,
      chatSpans,
    };
  }

  // 3. Two parallel page fetches.
  const fetchStartA = cursor;
  const fetchStartB = cursor + randInt(rng, 30, 90);
  const fetchDurA = randInt(rng, 600, 1400);
  const fetchDurB = randInt(rng, 600, 1400);
  for (const [index, [startMs, dur]] of [
    [fetchStartA, fetchDurA] as const,
    [fetchStartB, fetchDurB] as const,
  ].entries()) {
    spans.push(
      span({
        rng,
        traceId,
        parentSpanId: rootSpanId,
        name: 'execute_tool web.fetch',
        kind: 'INTERNAL',
        startMs,
        endMs: startMs + dur,
        status: 'OK',
        operation: 'execute_tool',
        attrs: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'web.fetch',
          'gen_ai.tool.call.id': `call-fetch-${index + 1}`,
        },
      }),
    );
  }
  cursor = Math.max(fetchStartA + fetchDurA, fetchStartB + fetchDurB) + randInt(rng, 80, 150);

  // 4. Draft: the span the `no-refusal` eval bites on for v2.
  const draftOutput = spec.refusal ? pick(rng, REFUSAL_DRAFTS) : topic.draft;
  const draftDur = randInt(rng, 1300, 2400);
  addChat(
    'draft',
    rootSpanId,
    cursor,
    draftDur,
    'gpt-4o',
    'gpt-4o-2024-08-06',
    { input: randInt(rng, 480, 580), output: randInt(rng, 60, 96) },
    'draft: write the answer from the fetched sources',
    draftOutput,
    spec.refusal,
  );
  cursor += draftDur + randInt(rng, 70, 130);

  // 5. Summarizer sub-agent wrapping its own chat call.
  const subAgentStart = cursor;
  const summarizeStart = subAgentStart + randInt(rng, 40, 80);
  const summarizeDur = randInt(rng, 600, 1100);
  const subAgentEnd = summarizeStart + summarizeDur + randInt(rng, 30, 70);
  const subAgentId = hexId(rng, 16);
  const subAgentRow = span({
    rng,
    traceId,
    parentSpanId: rootSpanId,
    name: 'invoke_agent summarizer',
    kind: 'INTERNAL',
    startMs: subAgentStart,
    endMs: subAgentEnd,
    status: 'OK',
    operation: 'invoke_agent',
    attrs: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'summarizer',
      'gen_ai.agent.id': 'agent-summarizer-1',
    },
  });
  subAgentRow.span_id = subAgentId;
  spans.push(subAgentRow);
  addChat(
    'summarize',
    subAgentId,
    summarizeStart,
    summarizeDur,
    'gpt-4o-mini',
    'gpt-4o-mini',
    { input: randInt(rng, 88, 114), output: randInt(rng, 30, 48) },
    'summarize: condense the draft to two sentences',
    topic.summary,
    false,
  );

  rootEnd = subAgentEnd + randInt(rng, 50, 110);
  const rootRow = span({
    rng,
    traceId,
    parentSpanId: '',
    name: 'invoke_agent researcher',
    kind: 'INTERNAL',
    startMs: rootStart,
    endMs: rootEnd,
    status: 'OK',
    operation: 'invoke_agent',
    attrs: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'researcher',
      'gen_ai.agent.id': 'agent-researcher-1',
    },
  });
  rootRow.span_id = rootSpanId;
  spans.push(rootRow);

  return {
    traceId,
    variant: spec.variant,
    startMs: rootStart,
    hardFailure: false,
    retried: spec.retried,
    spans,
    events,
    chatSpans,
  };
}

const HOUR = 3_600_000;

/**
 * The corpus timeline. Counts are FIXED (not sampled) where they feed the
 * regression math:
 *  - last 24h: 12 traces per variant; v1 has 1 refusal draft, v2 has 7 and
 *    each variant loses one trace to a hard failure (no draft at all), so the
 *    no-refusal pass rate is 33/34 (~0.97) vs 27/34 (~0.79), a drop of ~0.17
 *    against the default 0.1 threshold with 34 >= 10 samples per variant.
 *  - before that: v1 has a 6-day history; v2 appears ~36h ago as a canary
 *    that already showed the problem (2 refusals out of 4).
 */
function traceSpecs(rng: Rng, nowMs: number): TraceSpec[] {
  const specs: TraceSpec[] = [];

  const recentStart = (index: number): number =>
    // Newest trace ~30 min ago, oldest ~23.4h ago, with jitter.
    nowMs - 0.5 * HOUR - index * 1.9 * HOUR - randInt(rng, 0, 20) * 60_000;

  // v1, last 24h: 12 traces, refusal on one, one hard failure.
  for (let i = 0; i < 12; i++) {
    specs.push({
      variant: DEMO_VARIANTS.baseline,
      startMs: recentStart(i),
      refusal: i === 7,
      hardFailure: i === 4,
      retried: chance(rng, 0.35),
    });
  }
  // v2, last 24h: 12 traces, refusal on seven, one hard failure.
  for (let i = 0; i < 12; i++) {
    specs.push({
      variant: DEMO_VARIANTS.regressed,
      startMs: recentStart(i) - randInt(rng, 5, 25) * 60_000,
      refusal: [0, 2, 3, 5, 8, 9, 11].includes(i),
      hardFailure: i === 6,
      retried: chance(rng, 0.35),
    });
  }
  // v2 canary, 24-36h ago: 4 traces, 2 refusals.
  for (let i = 0; i < 4; i++) {
    specs.push({
      variant: DEMO_VARIANTS.regressed,
      startMs: nowMs - 24 * HOUR - randInt(rng, 1, 12) * HOUR - randInt(rng, 0, 55) * 60_000,
      refusal: i % 2 === 0,
      hardFailure: false,
      retried: chance(rng, 0.35),
    });
  }
  // v1 history, 24h-7d ago: 24 traces, 2 refusals, 2 hard failures.
  for (let i = 0; i < 24; i++) {
    specs.push({
      variant: DEMO_VARIANTS.baseline,
      startMs:
        nowMs - 24 * HOUR - (i * 5.4 + randFloat(rng, 0, 3)) * HOUR - randInt(rng, 0, 50) * 60_000,
      refusal: i === 5 || i === 16,
      hardFailure: i === 9 || i === 20,
      retried: chance(rng, 0.35),
    });
  }
  return specs;
}

export interface CorpusOptions {
  nowMs: number;
  seed?: number;
}

export function generateCorpus(options: CorpusOptions): Corpus {
  const rng = mulberry32(options.seed ?? 0x7ace_b100);
  const traces = traceSpecs(rng, options.nowMs).map((spec) => buildTrace(rng, spec));
  return {
    traces,
    spans: traces.flatMap((t) => t.spans),
    events: traces.flatMap((t) => t.events),
    chatSpans: traces.flatMap((t) => t.chatSpans),
  };
}
