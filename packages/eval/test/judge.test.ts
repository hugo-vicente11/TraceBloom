import type { ChatCompletionResponse, OpenAILike } from '@tracebloom/sdk';
import { describe, expect, it, vi } from 'vitest';
import { type JudgeClient, JudgeEvaluator, parseJudgeResponse } from '../src/judge.js';
import type { EvalInput } from '../src/types.js';

const input: EvalInput = {
  input: 'What is 2+2?',
  output: '4',
  span: {
    traceId: 't',
    spanId: 's',
    responseId: 'chatcmpl-1',
    requestModel: 'gpt-4o',
    operationName: 'chat',
    serviceName: 'svc',
    promptVersion: '',
    spanStartTime: '2026-07-02T00:00:00Z',
    attributes: {},
  },
};

/** A judge client whose reply content is supplied per call. */
function clientReturning(...contents: string[]): { client: JudgeClient; calls: () => number } {
  let i = 0;
  const create = vi.fn(async (): Promise<ChatCompletionResponse> => {
    const content = contents[Math.min(i, contents.length - 1)];
    i += 1;
    return {
      id: 'chatcmpl-judge',
      model: 'gpt-4o-mini',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    };
  });
  const client: OpenAILike = { chat: { completions: { create } } };
  return { client, calls: () => create.mock.calls.length };
}

describe('parseJudgeResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseJudgeResponse('{"score": 4, "pass": true, "reason": "ok"}')).toEqual({
      score: 4,
      pass: true,
      reason: 'ok',
    });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const out = parseJudgeResponse('Here you go:\n```json\n{"score": 2}\n```\nthanks');
    expect(out).toEqual({ score: 2, pass: undefined, reason: undefined });
  });

  it('returns undefined without a numeric score', () => {
    expect(parseJudgeResponse('no json here')).toBeUndefined();
    expect(parseJudgeResponse('{"reason":"x"}')).toBeUndefined();
  });
});

describe('JudgeEvaluator', () => {
  it('normalizes the score to 0..1 on the configured scale', async () => {
    const { client } = clientReturning('{"score": 4, "reason": "good"}');
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'correctness',
      scale: { min: 1, max: 5 },
    });
    // (4 - 1) / (5 - 1) = 0.75
    expect(outcome.score).toBeCloseTo(0.75, 10);
    expect(outcome.passed).toBe(true);
    expect(outcome.label).toBe('pass');
    expect(outcome.reason).toBe('good');
    expect(outcome.errorType).toBeUndefined();
  });

  it('marks a failure below the pass threshold', async () => {
    const { client } = clientReturning('{"score": 1}');
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'correctness',
      scale: { min: 1, max: 5 },
      passThreshold: 0.6,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.label).toBe('fail');
  });

  it('retries an unparseable response then succeeds', async () => {
    const { client, calls } = clientReturning('garbage', '{"score": 5}');
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'x',
      maxRetries: 1,
    });
    expect(outcome.score).toBe(1);
    expect(calls()).toBe(2);
  });

  it('returns a parse_error outcome (never throws) when all attempts fail', async () => {
    const { client } = clientReturning('still not json');
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'x',
      maxRetries: 1,
    });
    expect(outcome.errorType).toBe('parse_error');
    expect(outcome.score).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it('times out slow judge calls and reports errorType=timeout', async () => {
    const create = vi.fn(() => new Promise<ChatCompletionResponse>(() => {}));
    const client: OpenAILike = { chat: { completions: { create } } };
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'x',
      timeoutMs: 20,
      maxRetries: 0,
    });
    expect(outcome.errorType).toBe('timeout');
  });

  it('surfaces a thrown provider error as an errored outcome', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    const client: OpenAILike = { chat: { completions: { create } } };
    const evaluator = new JudgeEvaluator(client);
    const outcome = await evaluator.evaluate(input, {
      model: 'gpt-4o-mini',
      criteria: 'x',
      maxRetries: 0,
    });
    expect(outcome.errorType).toBe('Error');
    expect(outcome.passed).toBe(false);
  });
});
