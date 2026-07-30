"""Cost computation + the shared-pricing contract with the TS SDK."""

from __future__ import annotations

import json
from pathlib import Path

from tracebloom import DEFAULT_PRICING, ModelPrice, compute_cost, lookup_price

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_computes_cost_from_per_mtok_pricing() -> None:
    cost = compute_cost("gpt-4o", 1_000_000, 1_000_000)
    assert cost.input_usd == 2.5
    assert cost.output_usd == 10.0
    assert cost.total_usd == 12.5


def test_matches_version_suffixed_models_by_longest_prefix() -> None:
    assert lookup_price("gpt-4o-2024-08-06", DEFAULT_PRICING) == DEFAULT_PRICING["gpt-4o"]
    # gpt-4.1-mini-... must match gpt-4.1-mini, not the shorter gpt-4.1.
    assert (
        lookup_price("gpt-4.1-mini-2025-04-14", DEFAULT_PRICING) == DEFAULT_PRICING["gpt-4.1-mini"]
    )


def test_unknown_model_costs_zero() -> None:
    cost = compute_cost("mystery-model", 100, 100)
    assert (cost.input_usd, cost.output_usd, cost.total_usd) == (0.0, 0.0, 0.0)


def test_honors_a_custom_pricing_map() -> None:
    cost = compute_cost(
        "tiny", 2_000_000, 0, {"tiny": ModelPrice(input_per_mtok=1, output_per_mtok=1)}
    )
    assert cost.total_usd == 2.0


def test_vendored_pricing_is_byte_identical_to_canonical() -> None:
    # A drifted copy means someone edited the vendored file directly (a fork).
    # Edit pricing/model-prices.json and run `pnpm pricing:sync` instead.
    canonical = (REPO_ROOT / "pricing" / "model-prices.json").read_text(encoding="utf-8")
    vendored = (
        REPO_ROOT / "packages" / "sdk-py" / "src" / "tracebloom" / "_pricing.json"
    ).read_text(encoding="utf-8")
    assert vendored == canonical


def test_produces_exactly_the_shared_cost_parity_fixture_values() -> None:
    fixture = json.loads(
        (REPO_ROOT / "pricing" / "cost-parity-cases.json").read_text(encoding="utf-8")
    )
    cases = fixture["cases"]
    assert len(cases) > 0
    for case in cases:
        cost = compute_cost(case["model"], case["input_tokens"], case["output_tokens"])
        # Exact equality on purpose: the TS SDK asserts the same fixture, so
        # both SDKs are pinned to identical IEEE-754 results, not "close enough".
        assert cost.input_usd == case["expected"]["input_usd"], case["model"]
        assert cost.output_usd == case["expected"]["output_usd"], case["model"]
        assert cost.total_usd == case["expected"]["total_usd"], case["model"]
