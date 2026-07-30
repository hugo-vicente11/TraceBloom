/**
 * Demo eval definitions + seeded eval results.
 *
 * The two definitions are the SAME sample evals `pnpm eval:seed` installs
 * (apps/eval-runner/src/seed.ts): names are unique, so whichever ran first
 * wins and the other is a no-op.
 *
 * Result rows: `no-refusal` scores are computed by the REAL
 * DeterministicEvaluator over the seeded content, so they are byte-compatible
 * with what the live runner would produce (and the runner's idempotency check
 * skips re-scoring them). `answer-quality` is an LLM-judge eval, the demo
 * runs without any API key, so its historical scores and rationales are
 * seeded directly; the row shape (including content_hash) matches the
 * runner's exactly.
 */

import { type Database, type EvalDefinition, evalDefinitions } from '@tracebloom/db';
import {
  contentHash,
  type DeterministicConfig,
  DeterministicEvaluator,
  type EvalInput,
  validateConfig,
} from '@tracebloom/eval';
import { inArray } from 'drizzle-orm';
import type { CorpusChatSpan } from './corpus.js';
import { chDateTime } from './corpus.js';
import { mulberry32, pick, type Rng, randFloat, randInt } from './rng.js';

export const EVAL_NAMES = ['no-refusal', 'answer-quality'] as const;

const NO_REFUSAL_CONFIG = {
  target: 'output',
  mode: 'all',
  rules: [
    { kind: 'not_contains', text: 'I cannot', caseSensitive: false },
    { kind: 'not_contains', text: 'as an AI', caseSensitive: false },
    { kind: 'max_length', max: 4000 },
  ],
} as const;

const ANSWER_QUALITY_CONFIG = {
  model: 'gpt-4o-mini',
  criteria:
    'Rate how helpful, correct, and complete the assistant output is as a response to the input.',
  scale: { min: 1, max: 5 },
  passThreshold: 0.6,
} as const;

/** Upsert the demo eval definitions and return them (by name). */
export async function ensureEvalDefinitions(db: Database): Promise<EvalDefinition[]> {
  await db
    .insert(evalDefinitions)
    .values([
      {
        name: 'no-refusal',
        type: 'deterministic',
        config: NO_REFUSAL_CONFIG as unknown as Record<string, unknown>,
        selector: { operations: ['chat'], samplingRate: 1 },
        enabled: true,
      },
      {
        name: 'answer-quality',
        type: 'llm_judge',
        config: ANSWER_QUALITY_CONFIG as unknown as Record<string, unknown>,
        selector: { operations: ['chat'], samplingRate: 1 },
        enabled: true,
      },
    ])
    .onConflictDoNothing({ target: evalDefinitions.name });
  return db
    .select()
    .from(evalDefinitions)
    .where(inArray(evalDefinitions.name, [...EVAL_NAMES]));
}

/** JSONEachRow shape for tracebloom.eval_results (see 0004). */
export interface DemoEvalResultRow {
  eval_id: string;
  eval_version: number;
  trace_id: string;
  span_id: string;
  response_id: string;
  evaluation_name: string;
  score_value: number;
  score_label: string;
  passed: number;
  explanation: string;
  error_type: string;
  evaluator_type: string;
  request_model: string;
  operation_name: string;
  service_name: string;
  prompt_version: string;
  variant: string;
  content_hash: string;
  span_start_time: string;
  evaluated_at: string;
  metadata_json: string;
}

function toEvalInput(chat: CorpusChatSpan): EvalInput {
  const row = chat.row;
  return {
    input: chat.input,
    output: chat.output,
    span: {
      traceId: row.trace_id,
      spanId: row.span_id,
      responseId: row.response_id,
      requestModel: row.request_model,
      operationName: row.operation_name,
      serviceName: row.service_name,
      promptVersion: chat.variant,
      spanStartTime: row.start_time,
      attributes: {},
    },
  };
}

function baseRow(
  def: EvalDefinition,
  chat: CorpusChatSpan,
  input: EvalInput,
  evaluatedAtMs: number,
): Omit<
  DemoEvalResultRow,
  'score_value' | 'score_label' | 'passed' | 'explanation' | 'metadata_json'
> {
  return {
    eval_id: def.id,
    eval_version: def.version,
    trace_id: chat.row.trace_id,
    span_id: chat.row.span_id,
    response_id: chat.row.response_id,
    evaluation_name: def.name,
    error_type: '',
    evaluator_type: def.type,
    request_model: chat.row.request_model,
    operation_name: chat.row.operation_name,
    service_name: chat.row.service_name,
    prompt_version: chat.variant,
    variant: chat.variant,
    content_hash: contentHash(def.version, input),
    span_start_time: chat.row.start_time,
    evaluated_at: chDateTime(evaluatedAtMs),
  };
}

const PLAN_REASONS = [
  'Plan covers search, retrieval and hand-off; steps are actionable.',
  'Clear four-step plan; could be more specific about source selection.',
  'Reasonable plan, follows the brief directly.',
];
const DRAFT_OK_REASONS = [
  'Draft answers the brief and cites the fetched sources.',
  'Accurate and complete; minor hedging but well grounded.',
  'Solid draft; the recommendation follows from the evidence.',
];
const DRAFT_WEAK_REASONS = [
  'Draft addresses the brief but drops one requested comparison point.',
  'Mostly grounded, though one claim is not supported by the fetched pages.',
];
const REFUSAL_REASONS = [
  'The response refuses to answer although the fetched sources were sufficient.',
  'Unwarranted refusal: the brief was answerable from the retrieved material.',
  'Refuses instead of drafting; no attempt to use the available sources.',
];
const SUMMARY_REASONS = [
  'Faithful two-sentence condensation of the draft.',
  'Concise and accurate summary.',
  'Summary preserves the key numbers from the draft.',
];

/** Crafted judge verdict for one chat span (deterministic via rng). */
function judgeVerdict(rng: Rng, chat: CorpusChatSpan): { score: number; reason: string } {
  if (chat.refusal) {
    return { score: randFloat(rng, 0.2, 0.42), reason: pick(rng, REFUSAL_REASONS) };
  }
  switch (chat.role) {
    case 'plan':
      return {
        score: chat.variant === 'v2' ? randFloat(rng, 0.66, 0.88) : randFloat(rng, 0.72, 0.92),
        reason: pick(rng, PLAN_REASONS),
      };
    case 'draft':
      return chat.variant === 'v2'
        ? { score: randFloat(rng, 0.6, 0.8), reason: pick(rng, DRAFT_WEAK_REASONS) }
        : { score: randFloat(rng, 0.78, 0.96), reason: pick(rng, DRAFT_OK_REASONS) };
    case 'summarize':
      return { score: randFloat(rng, 0.68, 0.9), reason: pick(rng, SUMMARY_REASONS) };
  }
}

/**
 * Build all seeded eval_results rows for the corpus chat spans: real
 * deterministic scores for `no-refusal`, crafted judge scores for
 * `answer-quality`.
 */
export async function buildEvalResults(
  chatSpans: CorpusChatSpan[],
  defs: EvalDefinition[],
  seed = 0x5eed_e7a1,
): Promise<DemoEvalResultRow[]> {
  const rng = mulberry32(seed);
  const noRefusal = defs.find((d) => d.name === 'no-refusal');
  const answerQuality = defs.find((d) => d.name === 'answer-quality');
  if (!noRefusal || !answerQuality) {
    throw new Error('demo eval definitions missing');
  }
  const detConfig = validateConfig('deterministic', noRefusal.config) as DeterministicConfig;
  const evaluator = new DeterministicEvaluator(noRefusal.name);

  const rows: DemoEvalResultRow[] = [];
  for (const chat of chatSpans) {
    const input = toEvalInput(chat);
    const spanEndMs = Date.parse(`${chat.row.end_time.replace(' ', 'T')}Z`);
    // Evals run out-of-band: results land a few minutes after the span.
    const evaluatedAtMs = spanEndMs + randInt(rng, 45, 240) * 1000;

    const outcome = await evaluator.evaluate(input, detConfig);
    rows.push({
      ...baseRow(noRefusal, chat, input, evaluatedAtMs),
      score_value: outcome.score,
      score_label: outcome.label ?? '',
      passed: outcome.passed ? 1 : 0,
      explanation: outcome.reason ?? '',
      metadata_json: JSON.stringify(outcome.metadata ?? {}),
    });

    const verdict = judgeVerdict(rng, chat);
    const score = Math.round(verdict.score * 1000) / 1000;
    const passed = score >= 0.6;
    rows.push({
      ...baseRow(answerQuality, chat, input, evaluatedAtMs + randInt(rng, 5, 60) * 1000),
      score_value: score,
      score_label: passed ? 'pass' : 'fail',
      passed: passed ? 1 : 0,
      explanation: verdict.reason,
      metadata_json: JSON.stringify({ demo_seed: true }),
    });
  }
  return rows;
}
