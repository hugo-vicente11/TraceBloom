import { describe, expect, it } from 'vitest';
import {
  computeVariant,
  reconstructIO,
  type SpanEventRow,
  type SpanRow,
  sampleDecision,
  toEvaluatedSpan,
} from '../src/spans.js';

describe('reconstructIO', () => {
  it('splits input (user/system) from output (choice/assistant) events', () => {
    const events: SpanEventRow[] = [
      { span_id: 's', name: 'gen_ai.system.message', body: '{"content":"be terse"}' },
      { span_id: 's', name: 'gen_ai.user.message', body: '{"content":"hi"}' },
      { span_id: 's', name: 'gen_ai.choice', body: '{"index":0,"content":"hello"}' },
    ];
    expect(reconstructIO(events)).toEqual({ input: 'be terse\nhi', output: 'hello' });
  });

  it('stringifies non-string content and tolerates non-JSON bodies', () => {
    const events: SpanEventRow[] = [
      { span_id: 's', name: 'gen_ai.user.message', body: '{"content":{"a":1}}' },
      { span_id: 's', name: 'gen_ai.choice', body: 'plain text' },
    ];
    expect(reconstructIO(events)).toEqual({ input: '{"a":1}', output: 'plain text' });
  });

  it('returns empty strings when there are no content events', () => {
    expect(reconstructIO([])).toEqual({ input: '', output: '' });
  });
});

describe('computeVariant', () => {
  it('prefers the prompt version, falling back to the model', () => {
    expect(computeVariant('v2', 'gpt-4o')).toBe('v2');
    expect(computeVariant('', 'gpt-4o')).toBe('gpt-4o');
  });
});

describe('sampleDecision', () => {
  it('is deterministic for a given span id and rate', () => {
    const first = sampleDecision('span-abc', 0.5);
    for (let i = 0; i < 5; i++) {
      expect(sampleDecision('span-abc', 0.5)).toBe(first);
    }
  });

  it('always includes at rate 1 and always excludes at rate 0', () => {
    expect(sampleDecision('x', 1)).toBe(true);
    expect(sampleDecision('x', 0)).toBe(false);
  });

  it('samples roughly the configured fraction over many ids', () => {
    let included = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      if (sampleDecision(`span-${i}`, 0.25)) {
        included += 1;
      }
    }
    expect(included / n).toBeGreaterThan(0.2);
    expect(included / n).toBeLessThan(0.3);
  });
});

describe('toEvaluatedSpan', () => {
  it('parses the attributes JSON and maps columns', () => {
    const row: SpanRow = {
      trace_id: 't',
      span_id: 's',
      response_id: 'chatcmpl-1',
      request_model: 'gpt-4o',
      operation_name: 'chat',
      service_name: 'svc',
      span_start_time: '2026-07-02 00:00:00.000000000',
      prompt_version: 'v2',
      attributes_json: '{"gen_ai.prompt.version":"v2"}',
    };
    const span = toEvaluatedSpan(row);
    expect(span.responseId).toBe('chatcmpl-1');
    expect(span.promptVersion).toBe('v2');
    expect(span.attributes['gen_ai.prompt.version']).toBe('v2');
  });

  it('tolerates malformed attributes JSON', () => {
    const row = { attributes_json: 'not json' } as SpanRow;
    expect(toEvaluatedSpan(row).attributes).toEqual({});
  });
});
