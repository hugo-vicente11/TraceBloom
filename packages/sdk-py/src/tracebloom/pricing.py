"""Token pricing and cost computation.

Prices are USD per 1,000,000 tokens and come from the repo's single canonical
pricing file (``pricing/model-prices.json``), vendored here as ``_pricing.json``
by ``pnpm pricing:sync`` so the TS and Python SDKs share one source of truth and
produce identical costs (a shared fixture pins the exact IEEE-754 results). Pass
your own map to ``init(pricing=...)`` to override. The numbers are illustrative
defaults, not a billing source of truth; keep them current for your providers.
Mirrors ``packages/sdk-ts/src/pricing.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import cast


@dataclass(frozen=True)
class ModelPrice:
    """Price of one model, USD per 1,000,000 tokens."""

    #: USD per 1,000,000 input (prompt) tokens.
    input_per_mtok: float
    #: USD per 1,000,000 output (completion) tokens.
    output_per_mtok: float


PricingMap = Mapping[str, ModelPrice]


@dataclass(frozen=True)
class CostBreakdown:
    """Computed cost of one call, in USD."""

    input_usd: float
    output_usd: float
    total_usd: float


_ZERO_COST = CostBreakdown(input_usd=0.0, output_usd=0.0, total_usd=0.0)


def _load_default_pricing() -> PricingMap:
    raw = resources.files("tracebloom").joinpath("_pricing.json").read_text(encoding="utf-8")
    models = cast("dict[str, dict[str, float]]", json.loads(raw)["models"])
    return {
        model: ModelPrice(input_per_mtok=price["input"], output_per_mtok=price["output"])
        for model, price in models.items()
    }


DEFAULT_PRICING: PricingMap = _load_default_pricing()


def lookup_price(model: str, pricing: PricingMap) -> ModelPrice | None:
    """Look up a model's price, tolerating version-suffixed ids (e.g.
    ``gpt-4o-2024-08-06`` falls back to the ``gpt-4o`` entry) by
    longest-prefix match.
    """
    exact = pricing.get(model)
    if exact is not None:
        return exact
    best: ModelPrice | None = None
    best_len = -1
    for key, price in pricing.items():
        if model.startswith(key) and len(key) > best_len:
            best = price
            best_len = len(key)
    return best


def compute_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    pricing: PricingMap = DEFAULT_PRICING,
) -> CostBreakdown:
    """Compute input/output/total cost in USD. Unknown models cost 0.

    The arithmetic (`(tokens / 1_000_000) * per_mtok`, summed) is kept
    operation-for-operation identical to the TS SDK so both produce the same
    IEEE-754 doubles for the same usage.
    """
    price = lookup_price(model, pricing)
    if price is None:
        return _ZERO_COST
    input_usd = (input_tokens / 1_000_000) * price.input_per_mtok
    output_usd = (output_tokens / 1_000_000) * price.output_per_mtok
    return CostBreakdown(
        input_usd=input_usd,
        output_usd=output_usd,
        total_usd=input_usd + output_usd,
    )
