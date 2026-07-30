/**
 * Token pricing and cost computation.
 *
 * Prices are USD per 1,000,000 tokens and come from the repo's single canonical
 * pricing file (`pricing/model-prices.json`), vendored here as
 * `pricing-data.json` by `pnpm pricing:sync` so the TS and Python SDKs share
 * one source of truth and produce identical costs. Pass your own map to
 * `init({ pricing })` to override. The numbers are illustrative defaults, not
 * a billing source of truth; keep them current for your providers.
 */

import pricingData from './pricing-data.json' with { type: 'json' };

export interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPerMTok: number;
}

export type PricingMap = Record<string, ModelPrice>;

function fromCanonical(models: Record<string, { input: number; output: number }>): PricingMap {
  const map: PricingMap = {};
  for (const [model, price] of Object.entries(models)) {
    map[model] = { inputPerMTok: price.input, outputPerMTok: price.output };
  }
  return map;
}

export const DEFAULT_PRICING: PricingMap = fromCanonical(pricingData.models);

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

const ZERO_COST: CostBreakdown = { inputUsd: 0, outputUsd: 0, totalUsd: 0 };

/**
 * Look up a model's price, tolerating version-suffixed ids (e.g.
 * `gpt-4o-2024-08-06` falls back to the `gpt-4o` entry) by longest-prefix match.
 */
export function lookupPrice(model: string, pricing: PricingMap): ModelPrice | undefined {
  const exact = pricing[model];
  if (exact) {
    return exact;
  }
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [key, price] of Object.entries(pricing)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/** Compute input/output/total cost in USD. Unknown models cost 0 (and are logged upstream). */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: PricingMap = DEFAULT_PRICING,
): CostBreakdown {
  const price = lookupPrice(model, pricing);
  if (!price) {
    return ZERO_COST;
  }
  const inputUsd = (inputTokens / 1_000_000) * price.inputPerMTok;
  const outputUsd = (outputTokens / 1_000_000) * price.outputPerMTok;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}
