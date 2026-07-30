import { describe, expect, it } from 'vitest';
import type { SdkEvaluationEventRow } from '../src/clickhouse.js';
import { toSdkResultRow } from '../src/sdk-results.js';

function eventRow(body: Record<string, unknown>): SdkEvaluationEventRow {
  return {
    trace_id: 't1',
    span_id: 's1',
    body: JSON.stringify(body),
    response_id: 'resp-1',
    request_model: 'gpt-4o',
    operation_name: 'chat',
    service_name: 'agent-demo',
    span_start_time: '2026-07-15 12:00:00.000000000',
    prompt_version: 'v2',
  };
}

describe('toSdkResultRow', () => {
  it('materializes a scored event into an eval_results row', () => {
    const row = toSdkResultRow(
      eventRow({
        'gen_ai.evaluation.name': 'user_feedback',
        'gen_ai.evaluation.score.value': 0.9,
        'gen_ai.evaluation.score.label': 'thumbs_up',
        'gen_ai.evaluation.explanation': 'helpful',
      }),
    );
    expect(row).toMatchObject({
      eval_id: 'sdk:user_feedback',
      eval_version: 1,
      evaluation_name: 'user_feedback',
      score_value: 0.9,
      score_label: 'thumbs_up',
      passed: 1,
      explanation: 'helpful',
      error_type: '',
      evaluator_type: 'sdk',
      prompt_version: 'v2',
      variant: 'v2',
      span_id: 's1',
    });
  });

  it('marks low scores as not passed and untagged spans fall back to the model variant', () => {
    const row = toSdkResultRow({
      ...eventRow({
        'gen_ai.evaluation.name': 'quality',
        'gen_ai.evaluation.score.value': 0.2,
      }),
      prompt_version: '',
    });
    expect(row?.passed).toBe(0);
    expect(row?.variant).toBe('gpt-4o');
  });

  it('stores errored evaluations with score 0 and the error type', () => {
    const row = toSdkResultRow(
      eventRow({
        'gen_ai.evaluation.name': 'toxicity',
        'gen_ai.evaluation.score.value': 0.8,
        'error.type': 'timeout',
      }),
    );
    expect(row).toMatchObject({ score_value: 0, passed: 0, error_type: 'timeout' });
  });

  it('skips malformed bodies rather than failing the promotion pass', () => {
    expect(toSdkResultRow({ ...eventRow({}), body: 'not json' })).toBeUndefined();
    expect(toSdkResultRow(eventRow({ missing: 'name' }))).toBeUndefined();
    expect(toSdkResultRow(eventRow({ 'gen_ai.evaluation.name': '' }))).toBeUndefined();
  });
});
