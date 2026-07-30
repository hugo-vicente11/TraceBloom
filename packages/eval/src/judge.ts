/**
 * LLM-as-judge evaluator. Given a rubric plus the span's input and output, it
 * asks a configured judge model for a structured verdict (numeric score +
 * pass/fail + rationale) and normalizes the score to [0, 1].
 *
 * Cost & resilience (DECISIONS.md D10): the judge call has a timeout and bounded
 * retries with exponential backoff; every failure mode is caught and returned as
 * an `errorType` outcome so a judge error can never crash the runner. The client
 * is injected (`JudgeClient`) so tests use a mock and the runner can wrap it with
 * the TraceBloom SDK to emit `gen_ai` spans for the judge's own calls (decision #2).
 */

import type { ChatCompletionResponse, OpenAILike } from '@tracebloom/sdk';
import type { EvalInput, EvalOutcome, Evaluator } from './types.js';

/** Any OpenAI-shaped chat client. Wrap it with `instrumentOpenAI` to dogfood. */
export type JudgeClient = OpenAILike;

export interface JudgeConfig {
  /** Judge model id, e.g. `gpt-4o-mini`. */
  model: string;
  /** The rubric / criteria: what makes a good answer. */
  criteria: string;
  /** Raw score range the judge is asked to use. Default 1..5. */
  scale?: { min: number; max: number };
  /** Normalized (0..1) threshold at or above which the output passes. Default 0.6. */
  passThreshold?: number;
  /** Optional prompt override with `{criteria}`, `{input}`, `{output}` placeholders. */
  promptTemplate?: string;
  /** Sampling temperature for the judge. Default 0 (deterministic-ish). */
  temperature?: number;
  /** Max tokens for the judge response. Default 512. */
  maxTokens?: number;
  /** Metric name recorded as `gen_ai.evaluation.name`. Default the evaluator's name. */
  metricName?: string;
  /** Per-call timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
}

const DEFAULT_SCALE = { min: 1, max: 5 };
const DEFAULT_PASS_THRESHOLD = 0.6;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

const DEFAULT_TEMPLATE = `You are a strict evaluation judge. Score the ASSISTANT OUTPUT against the CRITERIA.

CRITERIA:
{criteria}

INPUT (the prompt the assistant was given):
{input}

ASSISTANT OUTPUT:
{output}

Respond with ONLY a JSON object, no prose, of the form:
{"score": <number between {min} and {max}>, "pass": <true|false>, "reason": "<one sentence>"}`;

/** Parsed shape we ask the judge to emit. */
export interface JudgeVerdict {
  score: number;
  pass?: boolean;
  reason?: string;
}

class TimeoutError extends Error {
  constructor() {
    super('judge call timed out');
    this.name = 'TimeoutError';
  }
}

function buildPrompt(config: JudgeConfig, input: EvalInput): string {
  const scale = config.scale ?? DEFAULT_SCALE;
  return (config.promptTemplate ?? DEFAULT_TEMPLATE)
    .replaceAll('{criteria}', config.criteria)
    .replaceAll('{input}', input.input || '(no input captured)')
    .replaceAll('{output}', input.output || '(no output captured)')
    .replaceAll('{min}', String(scale.min))
    .replaceAll('{max}', String(scale.max));
}

/**
 * Extract the judge's JSON verdict from a completion, tolerating markdown code
 * fences and surrounding prose. Returns `undefined` if no parseable object with a
 * numeric `score` is found.
 */
export function parseJudgeResponse(content: string): JudgeVerdict | undefined {
  const withoutFences = content.replace(/```(?:json)?/gi, '');
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(withoutFences.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.score !== 'number' || !Number.isFinite(record.score)) {
      return undefined;
    }
    return {
      score: record.score,
      pass: typeof record.pass === 'boolean' ? record.pass : undefined,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalize(rawScore: number, scale: { min: number; max: number }): number {
  if (scale.max === scale.min) {
    return 0;
  }
  const clamped = Math.min(Math.max(rawScore, scale.min), scale.max);
  return (clamped - scale.min) / (scale.max - scale.min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class JudgeEvaluator implements Evaluator<JudgeConfig> {
  readonly type = 'llm_judge' as const;
  readonly name: string;

  constructor(
    private readonly client: JudgeClient,
    name = 'LLMJudge',
  ) {
    this.name = name;
  }

  private async callOnce(config: JudgeConfig, prompt: string): Promise<ChatCompletionResponse> {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([
        this.client.chat.completions.create({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature ?? 0,
          max_tokens: config.maxTokens ?? 512,
          // Nudge JSON-capable providers; ignored elsewhere and parsed defensively.
          response_format: { type: 'json_object' },
        }),
        timeout,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async evaluate(input: EvalInput, config: JudgeConfig): Promise<EvalOutcome> {
    const scale = config.scale ?? DEFAULT_SCALE;
    const passThreshold = config.passThreshold ?? DEFAULT_PASS_THRESHOLD;
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const prompt = buildPrompt(config, input);

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter: 250ms, 500ms, ...
        await sleep(250 * 2 ** (attempt - 1) + Math.random() * 100);
      }
      try {
        const response = await this.callOnce(config, prompt);
        const content = response.choices?.[0]?.message?.content ?? '';
        const verdict = parseJudgeResponse(content);
        if (!verdict) {
          // A malformed response is worth one more try (models occasionally add prose).
          lastError = new Error('unparseable judge response');
          continue;
        }
        const score = normalize(verdict.score, scale);
        const passed = verdict.pass ?? score >= passThreshold;
        return {
          score,
          passed,
          label: passed ? 'pass' : 'fail',
          reason: verdict.reason,
          metadata: {
            rawScore: verdict.score,
            scale,
            passThreshold,
            judgeModel: config.model,
            attempts: attempt + 1,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }

    // Exhausted retries: never throw: record the failure as an errored outcome.
    const errorType =
      lastError instanceof TimeoutError
        ? 'timeout'
        : lastError instanceof Error && lastError.message === 'unparseable judge response'
          ? 'parse_error'
          : lastError instanceof Error && lastError.name
            ? lastError.name
            : '_OTHER';
    return {
      score: 0,
      passed: false,
      reason: lastError instanceof Error ? lastError.message : 'judge failed',
      errorType,
      metadata: { attempts: maxRetries + 1, judgeModel: config.model },
    };
  }
}
