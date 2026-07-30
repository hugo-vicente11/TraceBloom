"""One-line auto-instrumentation: real openai/anthropic clients against mocked
HTTP transports (no network, no API keys), plus the no-op guarantees."""

from __future__ import annotations

from typing import Any

import anthropic
import httpx
import openai
import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider

import tracebloom
from tests.conftest import SdkFactory
from tracebloom.instrument import apply_instrumentations

OPENAI_RESPONSE: dict[str, Any] = {
    "id": "chatcmpl-abc123",
    "object": "chat.completion",
    "created": 1752345678,
    "model": "gpt-4o-2024-08-06",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "the plan"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 138, "completion_tokens": 61, "total_tokens": 199},
}

ANTHROPIC_RESPONSE: dict[str, Any] = {
    "id": "msg_abc123",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-4-6",
    "content": [{"type": "text", "text": "the summary"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 96, "output_tokens": 38},
}


def mock_openai_client() -> openai.OpenAI:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=OPENAI_RESPONSE))
    return openai.OpenAI(api_key="test-key", http_client=httpx.Client(transport=transport))


def mock_anthropic_client() -> anthropic.Anthropic:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=ANTHROPIC_RESPONSE))
    return anthropic.Anthropic(api_key="test-key", http_client=httpx.Client(transport=transport))


def call_openai() -> None:
    mock_openai_client().chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "plan the research"}],
        temperature=0.2,
    )


def call_anthropic() -> None:
    mock_anthropic_client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=100,
        messages=[{"role": "user", "content": "summarize"}],
    )


def genai_spans(spans: tuple[ReadableSpan, ...]) -> list[ReadableSpan]:
    """The spans emitted by provider instrumentation (LLM chat operations)."""
    return [
        s
        for s in spans
        if s.attributes is not None and s.attributes.get("gen_ai.operation.name") == "chat"
    ]


def test_openai_call_emits_conformant_gen_ai_span_with_cost(sdk: SdkFactory) -> None:
    exporter = sdk()
    assert "openai" in tracebloom.get_state().instrumented
    call_openai()

    (span,) = genai_spans(exporter.get_finished_spans())
    attrs = span.attributes
    assert attrs is not None
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["gen_ai.provider.name"] == "openai"
    assert attrs["gen_ai.request.model"] == "gpt-4o"
    assert attrs["gen_ai.response.model"] == "gpt-4o-2024-08-06"
    assert attrs["gen_ai.response.id"] == "chatcmpl-abc123"
    assert attrs["gen_ai.usage.input_tokens"] == 138
    assert attrs["gen_ai.usage.output_tokens"] == 61
    expected = tracebloom.compute_cost("gpt-4o-2024-08-06", 138, 61)
    assert attrs["tracebloom.cost.total_usd"] == expected.total_usd
    # Content capture is off by default: nothing content-shaped anywhere.
    assert "gen_ai.input.messages" not in attrs
    assert "gen_ai.output.messages" not in attrs
    assert [e for e in span.events if "message" in e.name or "choice" in e.name] == []


def test_anthropic_call_emits_conformant_gen_ai_span_with_cost(sdk: SdkFactory) -> None:
    exporter = sdk()
    assert "anthropic" in tracebloom.get_state().instrumented
    call_anthropic()

    (span,) = genai_spans(exporter.get_finished_spans())
    attrs = span.attributes
    assert attrs is not None
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["gen_ai.provider.name"] == "anthropic"
    assert attrs["gen_ai.request.model"] == "claude-sonnet-4-6"
    assert attrs["gen_ai.usage.input_tokens"] == 96
    assert attrs["gen_ai.usage.output_tokens"] == 38
    expected = tracebloom.compute_cost("claude-sonnet-4-6", 96, 38)
    assert attrs["tracebloom.cost.total_usd"] == expected.total_usd
    assert "gen_ai.input.messages" not in attrs
    assert "gen_ai.output.messages" not in attrs


def test_capture_on_converts_content_to_span_events(sdk: SdkFactory) -> None:
    exporter = sdk(capture_content=True)
    call_openai()

    (span,) = genai_spans(exporter.get_finished_spans())
    assert span.attributes is not None
    assert "gen_ai.input.messages" not in span.attributes
    assert "gen_ai.output.messages" not in span.attributes
    events = {event.name: event for event in span.events}
    user = events["gen_ai.user.message"].attributes
    assert user is not None and user["content"] == "plan the research"
    choice = events["gen_ai.choice"].attributes
    assert choice is not None
    assert choice["content"] == "the plan"
    assert choice["finish_reason"] == "stop"


def test_auto_instrumented_call_nests_under_agent_span(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.agent_span("researcher"), tracebloom.prompt_version("v2", "research"):
        call_openai()

    spans = exporter.get_finished_spans()
    root = next(s for s in spans if s.name == "invoke_agent researcher")
    (llm,) = genai_spans(spans)
    assert llm.parent is not None
    assert llm.parent.span_id == root.context.span_id
    assert llm.context.trace_id == root.context.trace_id
    # The contextvar prompt tag reached the auto-instrumented span.
    assert llm.attributes is not None
    assert llm.attributes["gen_ai.prompt.version"] == "v2"
    assert llm.attributes["gen_ai.prompt.name"] == "research"


def test_instrument_empty_list_disables_auto_instrumentation(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=[])
    assert tracebloom.get_state().instrumented == ()
    call_openai()
    assert genai_spans(exporter.get_finished_spans()) == []


def test_shutdown_uninstruments(sdk: SdkFactory) -> None:
    exporter = sdk()
    tracebloom.shutdown()
    tracebloom.init(instrument=[])
    call_openai()
    assert genai_spans(exporter.get_finished_spans()) == []


def test_unknown_instrumentation_name_is_skipped_with_warning(
    sdk: SdkFactory, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("WARNING", logger="tracebloom"):
        sdk(instrument=["openai", "not-a-provider"])
    assert tracebloom.get_state().instrumented == ("openai",)
    assert any("not-a-provider" in message for message in caplog.messages)


def test_missing_library_is_a_silent_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    import tracebloom.instrument as instrument_module

    monkeypatch.setitem(
        instrument_module._REGISTRY,
        "ghost",
        instrument_module._Entry(
            "definitely_not_an_installed_module_xyz", "ghost", instrument_module._load_openai
        ),
    )
    applied = apply_instrumentations(["ghost"], TracerProvider())
    assert applied == ()
