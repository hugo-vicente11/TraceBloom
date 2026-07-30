import { describe, expect, it } from 'vitest';
import {
  contentHash,
  EVALUATION_RESULT_EVENT,
  EvaluationAttr,
  toEvaluationResultEvent,
} from '../src/result.js';
import type { EvalInput, EvalOutcome } from '../src/types.js';

describe('toEvaluationResultEvent', () => {
  it('maps a successful outcome onto the OTel gen_ai.evaluation.result event', () => {
    const outcome: EvalOutcome = {
      score: 0.75,
      passed: true,
      label: 'pass',
      reason: 'looks good',
    };
    const event = toEvaluationResultEvent('Relevance', outcome, 'chatcmpl-1');
    expect(event.name).toBe(EVALUATION_RESULT_EVENT);
    expect(event.attributes).toEqual({
      [EvaluationAttr.NAME]: 'Relevance',
      [EvaluationAttr.SCORE_VALUE]: 0.75,
      [EvaluationAttr.SCORE_LABEL]: 'pass',
      [EvaluationAttr.EXPLANATION]: 'looks good',
      [EvaluationAttr.RESPONSE_ID]: 'chatcmpl-1',
    });
  });

  it('omits score and emits error.type for an errored outcome', () => {
    const outcome: EvalOutcome = { score: 0, passed: false, errorType: 'timeout' };
    const event = toEvaluationResultEvent('Relevance', outcome, '');
    expect(event.attributes[EvaluationAttr.ERROR_TYPE]).toBe('timeout');
    expect(event.attributes[EvaluationAttr.SCORE_VALUE]).toBeUndefined();
    expect(event.attributes[EvaluationAttr.RESPONSE_ID]).toBeUndefined();
  });
});

describe('contentHash', () => {
  const input: EvalInput = {
    input: 'q',
    output: 'a',
    span: {
      traceId: 't',
      spanId: 's',
      responseId: 'r',
      requestModel: 'm',
      operationName: 'chat',
      serviceName: 'svc',
      promptVersion: '',
      spanStartTime: '2026-07-02T00:00:00Z',
      attributes: {},
    },
  };

  it('is stable for identical (version, input, output)', () => {
    expect(contentHash(1, input)).toBe(contentHash(1, input));
  });

  it('changes with the eval version so a version bump forces a re-score', () => {
    expect(contentHash(1, input)).not.toBe(contentHash(2, input));
  });

  it('changes when the output changes', () => {
    expect(contentHash(1, input)).not.toBe(contentHash(1, { ...input, output: 'b' }));
  });
});
