/**
 * Runtime validation that narrows the untyped `config` JSON stored in Postgres
 * into a typed evaluator config. The runner calls these before constructing an
 * evaluator so a malformed definition fails loudly (and is skipped) rather than
 * producing garbage scores.
 */

import type { DeterministicConfig, DeterministicRule } from './deterministic.js';
import type { JudgeConfig } from './judge.js';
import type { EvalType } from './types.js';

/** Thrown when a stored eval config does not match its declared type. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${ctx} must be an object`);
  }
  return value as Record<string, unknown>;
}

const RULE_KINDS: ReadonlySet<string> = new Set([
  'valid_json',
  'json_schema',
  'regex_match',
  'regex_no_match',
  'contains',
  'not_contains',
  'max_length',
]);

function validateRule(raw: unknown, i: number): DeterministicRule {
  const r = asRecord(raw, `rules[${i}]`);
  const kind = r.kind;
  if (typeof kind !== 'string' || !RULE_KINDS.has(kind)) {
    throw new ConfigError(`rules[${i}].kind is not a known rule kind`);
  }
  switch (kind) {
    case 'valid_json':
      return { kind };
    case 'json_schema':
      return { kind, schema: asRecord(r.schema, `rules[${i}].schema`) };
    case 'regex_match':
    case 'regex_no_match': {
      if (typeof r.pattern !== 'string') {
        throw new ConfigError(`rules[${i}].pattern must be a string`);
      }
      if (r.flags !== undefined && typeof r.flags !== 'string') {
        throw new ConfigError(`rules[${i}].flags must be a string`);
      }
      return { kind, pattern: r.pattern, flags: r.flags };
    }
    case 'contains':
    case 'not_contains': {
      if (typeof r.text !== 'string') {
        throw new ConfigError(`rules[${i}].text must be a string`);
      }
      if (r.caseSensitive !== undefined && typeof r.caseSensitive !== 'boolean') {
        throw new ConfigError(`rules[${i}].caseSensitive must be a boolean`);
      }
      return { kind, text: r.text, caseSensitive: r.caseSensitive };
    }
    case 'max_length': {
      if (typeof r.max !== 'number' || r.max < 0) {
        throw new ConfigError(`rules[${i}].max must be a non-negative number`);
      }
      return { kind, max: r.max };
    }
    default:
      // Unreachable: RULE_KINDS gate above.
      throw new ConfigError(`rules[${i}].kind is not a known rule kind`);
  }
}

export function validateDeterministicConfig(raw: unknown): DeterministicConfig {
  const c = asRecord(raw, 'config');
  if (!Array.isArray(c.rules) || c.rules.length === 0) {
    throw new ConfigError('deterministic config requires a non-empty `rules` array');
  }
  const rules = c.rules.map((rule, i) => validateRule(rule, i));
  const target = c.target;
  if (target !== undefined && target !== 'input' && target !== 'output') {
    throw new ConfigError('config.target must be "input" or "output"');
  }
  const mode = c.mode;
  if (mode !== undefined && mode !== 'all' && mode !== 'any') {
    throw new ConfigError('config.mode must be "all" or "any"');
  }
  return { rules, target, mode };
}

export function validateJudgeConfig(raw: unknown): JudgeConfig {
  const c = asRecord(raw, 'config');
  if (typeof c.model !== 'string' || c.model.length === 0) {
    throw new ConfigError('llm_judge config requires a `model` string');
  }
  if (typeof c.criteria !== 'string' || c.criteria.length === 0) {
    throw new ConfigError('llm_judge config requires a `criteria` string');
  }
  let scale: JudgeConfig['scale'];
  if (c.scale !== undefined) {
    const s = asRecord(c.scale, 'config.scale');
    if (typeof s.min !== 'number' || typeof s.max !== 'number' || s.max <= s.min) {
      throw new ConfigError('config.scale needs numeric min < max');
    }
    scale = { min: s.min, max: s.max };
  }
  const numberField = (key: string): number | undefined => {
    const v = c[key];
    if (v === undefined) {
      return undefined;
    }
    if (typeof v !== 'number') {
      throw new ConfigError(`config.${key} must be a number`);
    }
    return v;
  };
  const stringField = (key: string): string | undefined => {
    const v = c[key];
    if (v === undefined) {
      return undefined;
    }
    if (typeof v !== 'string') {
      throw new ConfigError(`config.${key} must be a string`);
    }
    return v;
  };
  return {
    model: c.model,
    criteria: c.criteria,
    scale,
    passThreshold: numberField('passThreshold'),
    promptTemplate: stringField('promptTemplate'),
    temperature: numberField('temperature'),
    maxTokens: numberField('maxTokens'),
    metricName: stringField('metricName'),
    timeoutMs: numberField('timeoutMs'),
    maxRetries: numberField('maxRetries'),
  };
}

/** Validate a config against its declared evaluator type. */
export function validateConfig(type: EvalType, raw: unknown): DeterministicConfig | JudgeConfig {
  return type === 'deterministic' ? validateDeterministicConfig(raw) : validateJudgeConfig(raw);
}
