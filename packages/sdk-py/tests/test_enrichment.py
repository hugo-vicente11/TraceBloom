"""The enrichment stage: cost computation, legacy-key normalization, and the
content rule (content becomes span events when capture is on, and NEVER
survives as a span attribute either way)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

import tracebloom
from tests.conftest import SdkFactory

INPUT_MESSAGES = json.dumps(
    [
        {"role": "system", "parts": [{"type": "text", "content": "be terse"}]},
        {"role": "user", "parts": [{"type": "text", "content": "plan the research"}]},
    ]
)
OUTPUT_MESSAGES = json.dumps(
    [
        {
            "role": "assistant",
            "parts": [{"type": "text", "content": "the plan"}],
            "finish_reason": "stop",
        }
    ]
)


def emit_llm_span(attributes: Mapping[str, Any], name: str = "chat gpt-4o") -> None:
    """Emit a span shaped like what a GenAI instrumentation produces."""
    tracer = tracebloom.get_state().tracer
    with tracer.start_as_current_span(name, kind=SpanKind.CLIENT) as span:
        for key, value in attributes.items():
            span.set_attribute(key, value)


def single_span(exporter: InMemorySpanExporter) -> ReadableSpan:
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    return spans[0]


def test_cost_computed_from_usage_and_shared_pricing(sdk: SdkFactory) -> None:
    exporter = sdk()
    emit_llm_span(
        {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.response.model": "gpt-4o-2024-08-06",
            "gen_ai.usage.input_tokens": 138,
            "gen_ai.usage.output_tokens": 61,
        }
    )
    attrs = single_span(exporter).attributes
    assert attrs is not None
    expected = tracebloom.compute_cost("gpt-4o-2024-08-06", 138, 61)
    assert attrs["tracebloom.cost.input_usd"] == expected.input_usd
    assert attrs["tracebloom.cost.output_usd"] == expected.output_usd
    assert attrs["tracebloom.cost.total_usd"] == expected.total_usd


def test_cost_respects_custom_pricing_and_existing_cost_wins(sdk: SdkFactory) -> None:
    exporter = sdk(
        pricing={"my-model": tracebloom.ModelPrice(input_per_mtok=100, output_per_mtok=200)}
    )
    emit_llm_span(
        {
            "gen_ai.request.model": "my-model",
            "gen_ai.usage.input_tokens": 1_000_000,
            "gen_ai.usage.output_tokens": 0,
        },
        name="chat my-model",
    )
    emit_llm_span(
        {
            "gen_ai.request.model": "my-model",
            "gen_ai.usage.input_tokens": 1_000_000,
            "tracebloom.cost.total_usd": 42.0,
        },
        name="precosted",
    )
    spans = exporter.get_finished_spans()
    by_name = {span.name: span for span in spans}
    first = by_name["chat my-model"].attributes
    assert first is not None
    assert first["tracebloom.cost.total_usd"] == 100.0
    precosted = by_name["precosted"].attributes
    assert precosted is not None
    assert precosted["tracebloom.cost.total_usd"] == 42.0
    assert "tracebloom.cost.input_usd" not in precosted


def test_spans_without_usage_get_no_cost(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.tool_span("web.search"):
        pass
    attrs = single_span(exporter).attributes
    assert attrs is not None
    assert "tracebloom.cost.total_usd" not in attrs


def test_legacy_keys_are_normalized(sdk: SdkFactory) -> None:
    exporter = sdk()
    emit_llm_span(
        {
            "gen_ai.system": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4-6",
            "gen_ai.usage.prompt_tokens": 1_000_000,
            "gen_ai.usage.completion_tokens": 1_000_000,
        }
    )
    attrs = single_span(exporter).attributes
    assert attrs is not None
    assert attrs["gen_ai.provider.name"] == "anthropic"
    assert attrs["gen_ai.usage.input_tokens"] == 1_000_000
    assert attrs["gen_ai.usage.output_tokens"] == 1_000_000
    assert "gen_ai.system" not in attrs
    assert "gen_ai.usage.prompt_tokens" not in attrs
    # Cost is computed from the normalized keys.
    assert attrs["tracebloom.cost.total_usd"] == 18.0


def test_content_attributes_become_events_when_capture_on(sdk: SdkFactory) -> None:
    exporter = sdk(capture_content=True)
    emit_llm_span(
        {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.input.messages": INPUT_MESSAGES,
            "gen_ai.output.messages": OUTPUT_MESSAGES,
        }
    )
    span = single_span(exporter)
    assert span.attributes is not None
    assert "gen_ai.input.messages" not in span.attributes
    assert "gen_ai.output.messages" not in span.attributes

    events = {event.name: event for event in span.events}
    assert set(events) == {"gen_ai.system.message", "gen_ai.user.message", "gen_ai.choice"}
    system = events["gen_ai.system.message"].attributes
    assert system is not None and system["content"] == "be terse"
    user = events["gen_ai.user.message"].attributes
    assert user is not None and user["content"] == "plan the research"
    choice = events["gen_ai.choice"].attributes
    assert choice is not None
    assert choice["content"] == "the plan"
    assert choice["finish_reason"] == "stop"
    assert choice["index"] == 0


def test_content_attributes_are_dropped_when_capture_off(sdk: SdkFactory) -> None:
    exporter = sdk(capture_content=False)
    emit_llm_span(
        {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.input.messages": INPUT_MESSAGES,
            "gen_ai.output.messages": OUTPUT_MESSAGES,
        }
    )
    span = single_span(exporter)
    assert span.attributes is not None
    # D2: content must never leave the process as a span attribute, and with
    # capture off, it must not leave as events either.
    assert "gen_ai.input.messages" not in span.attributes
    assert "gen_ai.output.messages" not in span.attributes
    assert [
        event for event in span.events if "message" in event.name or "choice" in event.name
    ] == []


def test_legacy_indexed_content_is_converted(sdk: SdkFactory) -> None:
    exporter = sdk(capture_content=True)
    emit_llm_span(
        {
            "gen_ai.request.model": "claude-sonnet-4-6",
            "gen_ai.prompt.0.role": "user",
            "gen_ai.prompt.0.content": "hello",
            "gen_ai.completion.0.role": "assistant",
            "gen_ai.completion.0.content": "hi there",
            "gen_ai.completion.0.finish_reason": "end_turn",
        }
    )
    span = single_span(exporter)
    assert span.attributes is not None
    assert not any(
        key.startswith(("gen_ai.prompt.0", "gen_ai.completion.0")) for key in span.attributes
    )
    events = {event.name: event for event in span.events}
    user = events["gen_ai.user.message"].attributes
    assert user is not None and user["content"] == "hello"
    choice = events["gen_ai.choice"].attributes
    assert choice is not None
    assert choice["content"] == "hi there"
    assert choice["finish_reason"] == "end_turn"
