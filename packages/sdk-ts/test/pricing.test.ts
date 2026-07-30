import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeCost, DEFAULT_PRICING, lookupPrice } from '../src/pricing.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('computeCost', () => {
  it('computes input/output/total from per-MTok pricing', () => {
    const cost = computeCost('gpt-4o', 1_000_000, 1_000_000);
    expect(cost.inputUsd).toBeCloseTo(2.5, 10);
    expect(cost.outputUsd).toBeCloseTo(10, 10);
    expect(cost.totalUsd).toBeCloseTo(12.5, 10);
  });

  it('matches version-suffixed models by longest prefix', () => {
    const price = lookupPrice('gpt-4o-2024-08-06', DEFAULT_PRICING);
    expect(price).toEqual(DEFAULT_PRICING['gpt-4o']);
  });

  it('returns zero for unknown models', () => {
    expect(computeCost('mystery-model', 100, 100)).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
    });
  });

  it('honors a custom pricing map', () => {
    const cost = computeCost('tiny', 2_000_000, 0, {
      tiny: { inputPerMTok: 1, outputPerMTok: 1 },
    });
    expect(cost.totalUsd).toBeCloseTo(2, 10);
  });
});

describe('shared pricing source of truth', () => {
  it('vendored pricing-data.json is byte-identical to the canonical file', () => {
    const canonical = readFileSync(join(repoRoot, 'pricing', 'model-prices.json'), 'utf8');
    const vendored = readFileSync(
      join(repoRoot, 'packages', 'sdk-ts', 'src', 'pricing-data.json'),
      'utf8',
    );
    // A drifted copy means someone edited the vendored file directly (a fork).
    // Edit pricing/model-prices.json and run `pnpm pricing:sync` instead.
    expect(vendored).toBe(canonical);
  });

  interface ParityCase {
    model: string;
    input_tokens: number;
    output_tokens: number;
    expected: { input_usd: number; output_usd: number; total_usd: number };
  }

  it('produces exactly the shared cost-parity fixture values', () => {
    const { cases } = JSON.parse(
      readFileSync(join(repoRoot, 'pricing', 'cost-parity-cases.json'), 'utf8'),
    ) as { cases: ParityCase[] };
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const cost = computeCost(c.model, c.input_tokens, c.output_tokens);
      // Exact equality on purpose: the Python SDK asserts the same fixture, so
      // both SDKs are pinned to identical IEEE-754 results, not "close enough".
      expect(cost.inputUsd, c.model).toBe(c.expected.input_usd);
      expect(cost.outputUsd, c.model).toBe(c.expected.output_usd);
      expect(cost.totalUsd, c.model).toBe(c.expected.total_usd);
    }
  });
});
