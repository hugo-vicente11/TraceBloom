import { describe, expect, it } from 'vitest';
import { ConfigError, validateDeterministicConfig, validateJudgeConfig } from '../src/config.js';

describe('validateDeterministicConfig', () => {
  it('accepts a well-formed config and defaults nothing it should not', () => {
    const config = validateDeterministicConfig({
      rules: [{ kind: 'contains', text: 'x' }],
      mode: 'any',
    });
    expect(config.rules).toHaveLength(1);
    expect(config.mode).toBe('any');
  });

  it('rejects an empty rules array', () => {
    expect(() => validateDeterministicConfig({ rules: [] })).toThrow(ConfigError);
  });

  it('rejects an unknown rule kind', () => {
    expect(() => validateDeterministicConfig({ rules: [{ kind: 'nope' }] })).toThrow(ConfigError);
  });

  it('rejects a regex rule without a pattern', () => {
    expect(() => validateDeterministicConfig({ rules: [{ kind: 'regex_match' }] })).toThrow(
      ConfigError,
    );
  });
});

describe('validateJudgeConfig', () => {
  it('accepts a minimal judge config', () => {
    const config = validateJudgeConfig({ model: 'gpt-4o-mini', criteria: 'be nice' });
    expect(config.model).toBe('gpt-4o-mini');
  });

  it('requires model and criteria', () => {
    expect(() => validateJudgeConfig({ criteria: 'x' })).toThrow(ConfigError);
    expect(() => validateJudgeConfig({ model: 'm' })).toThrow(ConfigError);
  });

  it('rejects an inverted scale', () => {
    expect(() =>
      validateJudgeConfig({ model: 'm', criteria: 'c', scale: { min: 5, max: 1 } }),
    ).toThrow(ConfigError);
  });
});
