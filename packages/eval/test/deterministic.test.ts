import { describe, expect, it } from 'vitest';
import { type DeterministicConfig, DeterministicEvaluator } from '../src/deterministic.js';
import type { EvalInput } from '../src/types.js';

function makeInput(output: string, input = ''): EvalInput {
  return {
    input,
    output,
    span: {
      traceId: 't',
      spanId: 's',
      responseId: 'r',
      requestModel: 'gpt-4o',
      operationName: 'chat',
      serviceName: 'svc',
      promptVersion: '',
      spanStartTime: '2026-07-02T00:00:00Z',
      attributes: {},
    },
  };
}

const evaluator = new DeterministicEvaluator();

function run(output: string, config: DeterministicConfig, input = '') {
  return evaluator.evaluate(makeInput(output, input), config);
}

describe('DeterministicEvaluator', () => {
  it('passes valid_json and fails on malformed JSON', async () => {
    const config: DeterministicConfig = { rules: [{ kind: 'valid_json' }] };
    expect((await run('{"a":1}', config)).passed).toBe(true);
    const bad = await run('not json', config);
    expect(bad.passed).toBe(false);
    expect(bad.score).toBe(0);
    expect(bad.label).toBe('fail');
  });

  it('validates against a JSON schema', async () => {
    const config: DeterministicConfig = {
      rules: [
        {
          kind: 'json_schema',
          schema: {
            type: 'object',
            required: ['name', 'age'],
            properties: { name: { type: 'string' }, age: { type: 'integer' } },
          },
        },
      ],
    };
    expect((await run('{"name":"a","age":3}', config)).passed).toBe(true);
    const missing = await run('{"name":"a"}', config);
    expect(missing.passed).toBe(false);
    expect(missing.reason).toContain('age');
  });

  it('supports regex match and no-match', async () => {
    expect(
      (await run('ID-1234', { rules: [{ kind: 'regex_match', pattern: '^ID-\\d+$' }] })).passed,
    ).toBe(true);
    expect(
      (await run('leaked secret', { rules: [{ kind: 'regex_no_match', pattern: 'secret' }] }))
        .passed,
    ).toBe(false);
  });

  it('supports contains / not_contains with case sensitivity', async () => {
    expect(
      (await run('Hello World', { rules: [{ kind: 'contains', text: 'World' }] })).passed,
    ).toBe(true);
    expect(
      (await run('Hello World', { rules: [{ kind: 'contains', text: 'world' }] })).passed,
    ).toBe(false);
    expect(
      (
        await run('Hello World', {
          rules: [{ kind: 'contains', text: 'world', caseSensitive: false }],
        })
      ).passed,
    ).toBe(true);
  });

  it('enforces max_length', async () => {
    expect((await run('abc', { rules: [{ kind: 'max_length', max: 3 }] })).passed).toBe(true);
    expect((await run('abcd', { rules: [{ kind: 'max_length', max: 3 }] })).passed).toBe(false);
  });

  it('scores the fraction of passing rules and honors mode all/any', async () => {
    const rules: DeterministicConfig['rules'] = [
      { kind: 'contains', text: 'a' },
      { kind: 'contains', text: 'z' },
    ];
    const all = await run('a only', { rules, mode: 'all' });
    expect(all.score).toBeCloseTo(0.5, 10);
    expect(all.passed).toBe(false);

    const any = await run('a only', { rules, mode: 'any' });
    expect(any.score).toBeCloseTo(0.5, 10);
    expect(any.passed).toBe(true);
  });

  it('targets the input text when configured', async () => {
    const config: DeterministicConfig = {
      rules: [{ kind: 'contains', text: 'question' }],
      target: 'input',
    };
    expect((await run('answer', config, 'the question')).passed).toBe(true);
  });

  it('fails closed on an invalid regex without throwing', async () => {
    const result = await run('x', { rules: [{ kind: 'regex_match', pattern: '(' }] });
    expect(result.passed).toBe(false);
    expect(result.errorType).toBeUndefined();
  });
});
