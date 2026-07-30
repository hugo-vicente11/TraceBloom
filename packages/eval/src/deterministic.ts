/**
 * Deterministic, rule-based evaluator. Fully config-driven: each rule is a cheap,
 * side-effect-free check over the span's input or output text. The score is the
 * fraction of rules that passed; `passed` is the AND (or OR, in `any` mode) of
 * the rules. No model call, no cost.
 */

import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';
import type { EvalInput, EvalOutcome, Evaluator } from './types.js';

// ajv-formats ships a CommonJS default that TypeScript's NodeNext interop types
// as the module namespace rather than the callable plugin; the runtime export is
// the function. Narrow it back to its documented call signature.
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => Ajv;

/** Which text a rule inspects. Defaults to the model output. */
export type DeterministicTarget = 'input' | 'output';

/** A single deterministic check. Discriminated on `kind`. */
export type DeterministicRule =
  | { kind: 'valid_json' }
  | { kind: 'json_schema'; schema: Record<string, unknown> }
  | { kind: 'regex_match'; pattern: string; flags?: string }
  | { kind: 'regex_no_match'; pattern: string; flags?: string }
  | { kind: 'contains'; text: string; caseSensitive?: boolean }
  | { kind: 'not_contains'; text: string; caseSensitive?: boolean }
  | { kind: 'max_length'; max: number };

export interface DeterministicConfig {
  rules: DeterministicRule[];
  /** Text the rules inspect. Default `output`. */
  target?: DeterministicTarget;
  /** `all` (default): pass iff every rule passes. `any`: pass iff at least one does. */
  mode?: 'all' | 'any';
}

interface RuleResult {
  kind: DeterministicRule['kind'];
  passed: boolean;
  detail?: string;
}

/** Ajv is stateless per schema; one shared instance with a small compiled-schema cache. */
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const cached = schemaCache.get(schema);
  if (cached) {
    return cached;
  }
  const validate = ajv.compile(schema);
  schemaCache.set(schema, validate);
  return validate;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function evaluateRule(rule: DeterministicRule, target: string): RuleResult {
  try {
    switch (rule.kind) {
      case 'valid_json': {
        const parsed = parseJson(target);
        return {
          kind: rule.kind,
          passed: parsed.ok,
          detail: parsed.ok ? undefined : 'not valid JSON',
        };
      }
      case 'json_schema': {
        const parsed = parseJson(target);
        if (!parsed.ok) {
          return { kind: rule.kind, passed: false, detail: 'not valid JSON' };
        }
        const validate = compileSchema(rule.schema);
        const ok = validate(parsed.value) === true;
        const detail = ok ? undefined : ajv.errorsText(validate.errors, { separator: '; ' });
        return { kind: rule.kind, passed: ok, detail };
      }
      case 'regex_match':
      case 'regex_no_match': {
        const re = new RegExp(rule.pattern, rule.flags);
        const matched = re.test(target);
        const wantMatch = rule.kind === 'regex_match';
        return {
          kind: rule.kind,
          passed: matched === wantMatch,
          detail:
            matched === wantMatch
              ? undefined
              : `/${rule.pattern}/ ${wantMatch ? 'did not match' : 'matched'}`,
        };
      }
      case 'contains':
      case 'not_contains': {
        const caseSensitive = rule.caseSensitive ?? true;
        const haystack = caseSensitive ? target : target.toLowerCase();
        const needle = caseSensitive ? rule.text : rule.text.toLowerCase();
        const found = haystack.includes(needle);
        const wantFound = rule.kind === 'contains';
        return {
          kind: rule.kind,
          passed: found === wantFound,
          detail:
            found === wantFound
              ? undefined
              : `${wantFound ? 'missing' : 'unexpected'} "${rule.text}"`,
        };
      }
      case 'max_length': {
        const ok = target.length <= rule.max;
        return {
          kind: rule.kind,
          passed: ok,
          detail: ok ? undefined : `length ${target.length} > ${rule.max}`,
        };
      }
    }
  } catch (error) {
    // A malformed rule (e.g. an invalid regex) fails closed rather than crashing.
    return {
      kind: rule.kind,
      passed: false,
      detail: error instanceof Error ? error.message : 'rule error',
    };
  }
}

export class DeterministicEvaluator implements Evaluator<DeterministicConfig> {
  readonly type = 'deterministic' as const;
  readonly name: string;

  constructor(name = 'Deterministic') {
    this.name = name;
  }

  // `async` to satisfy the Evaluator contract even though the checks are synchronous.
  async evaluate(input: EvalInput, config: DeterministicConfig): Promise<EvalOutcome> {
    const target = (config.target ?? 'output') === 'input' ? input.input : input.output;
    const mode = config.mode ?? 'all';
    const results = config.rules.map((rule) => evaluateRule(rule, target));

    const passedCount = results.filter((r) => r.passed).length;
    const total = results.length;
    // No rules configured is a degenerate pass (score 1); the runner validates
    // configs, so this only guards against an empty rules array.
    const score = total === 0 ? 1 : passedCount / total;
    const passed = total === 0 ? true : mode === 'all' ? passedCount === total : passedCount > 0;

    const failures = results.filter((r) => !r.passed);
    const reason =
      failures.length === 0
        ? `all ${total} rule(s) passed`
        : failures.map((r) => `${r.kind}: ${r.detail ?? 'failed'}`).join('; ');

    return {
      score,
      passed,
      label: passed ? 'pass' : 'fail',
      reason,
      metadata: { mode, target: config.target ?? 'output', rules: results },
    };
  }
}
