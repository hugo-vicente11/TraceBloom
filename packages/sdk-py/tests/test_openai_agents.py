"""OpenAI Agents SDK integration: a real Runner.run over the SDK's own
OpenAIChatCompletionsModel, pointed at a mocked httpx transport (no network,
no keys) so the SDK's response_span fires and the OpenInference Agents
instrumentor — which hooks the SDK's native trace-processor system via
set_trace_processors — captures the whole run. Adapted to canonical gen_ai by
the same _openinference mapping the LlamaIndex integration uses.

M7 contract: correct agent tree (invoke_agent → turn → chat / execute_tool,
plus the sub-agent), shared-pricing cost on the LLM spans, content toggle over
the OpenInference content keys, variant tagging through framework spans.
"""

from __future__ import annotations

from typing import Any

import httpx
from agents import Agent, OpenAIChatCompletionsModel, Runner, function_tool
from openai import AsyncOpenAI
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import tracebloom
from tests.conftest import SdkFactory

MODEL = "gpt-4o-2024-08-06"
PLAN_TOKENS = (120, 18)
ANSWER_TOKENS = (240, 12)


def _tool_call_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "web_search",
                                "arguments": '{"query": "otel genai"}',
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {
            "prompt_tokens": PLAN_TOKENS[0],
            "completion_tokens": PLAN_TOKENS[1],
            "total_tokens": sum(PLAN_TOKENS),
        },
    }


def _final_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-2",
        "object": "chat.completion",
        "created": 2,
        "model": MODEL,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Agents run complete."},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": ANSWER_TOKENS[0],
            "completion_tokens": ANSWER_TOKENS[1],
            "total_tokens": sum(ANSWER_TOKENS),
        },
    }


def _mock_client() -> AsyncOpenAI:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200, json=_tool_call_response() if calls["n"] == 1 else _final_response()
        )

    return AsyncOpenAI(
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


@function_tool
def web_search(query: str) -> str:
    """Search the public web."""
    return "results: tracebloom.dev"


def run_agent() -> None:
    agent = Agent(
        name="researcher",
        instructions="Research things.",
        tools=[web_search],
        model=OpenAIChatCompletionsModel(model=MODEL, openai_client=_mock_client()),
    )
    # Runner.run is async; run it on a private loop so the test stays sync.
    import asyncio

    asyncio.run(Runner.run(agent, "find otel genai news"))


def by_operation(spans: tuple[ReadableSpan, ...], operation: str) -> list[ReadableSpan]:
    return [
        s
        for s in spans
        if s.attributes is not None and s.attributes.get("gen_ai.operation.name") == operation
    ]


def run_and_collect(exporter: InMemorySpanExporter) -> tuple[ReadableSpan, ...]:
    run_agent()
    return exporter.get_finished_spans()


def test_openai_agents_run_produces_conformant_agent_tree(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["openai_agents"])
    assert tracebloom.get_state().instrumented == ("openai_agents",)
    spans = run_and_collect(exporter)

    (root,) = [s for s in spans if s.parent is None]
    assert root.attributes is not None
    assert root.attributes["gen_ai.operation.name"] == "invoke_agent"
    assert all(s.context.trace_id == root.context.trace_id for s in spans)

    # The named agent surfaces as an invoke_agent span carrying its id.
    agents = by_operation(spans, "invoke_agent")
    researcher = next(
        s for s in agents if s.attributes and s.attributes.get("gen_ai.agent.name") == "researcher"
    )
    assert researcher.attributes is not None
    assert researcher.attributes["gen_ai.agent.id"] == "researcher"
    assert researcher.name == "invoke_agent researcher"

    # Two LLM calls, canonical chat shape with model + usage.
    chats = by_operation(spans, "chat")
    assert len(chats) == 2
    for chat in chats:
        assert chat.attributes is not None
        assert chat.name == f"chat {MODEL}"
        assert chat.attributes["gen_ai.request.model"] == MODEL
        assert chat.attributes["gen_ai.provider.name"] == "openai"
    assert {c.attributes["gen_ai.usage.input_tokens"] for c in chats if c.attributes} == {
        PLAN_TOKENS[0],
        ANSWER_TOKENS[0],
    }

    # The tool call is captured and nests inside the run.
    (tool_span,) = by_operation(spans, "execute_tool")
    assert tool_span.attributes is not None
    assert tool_span.attributes["gen_ai.tool.name"] == "web_search"
    assert tool_span.name == "execute_tool web_search"


def test_openai_agents_chat_cost_from_shared_pricing(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["openai_agents"])
    spans = run_and_collect(exporter)
    plan = next(
        c
        for c in by_operation(spans, "chat")
        if c.attributes and c.attributes["gen_ai.usage.input_tokens"] == PLAN_TOKENS[0]
    )
    expected = tracebloom.compute_cost(MODEL, *PLAN_TOKENS)
    assert plan.attributes is not None
    assert plan.attributes["tracebloom.cost.total_usd"] == expected.total_usd
    assert plan.attributes["tracebloom.cost.input_usd"] == expected.input_usd


def test_openinference_content_stripped_by_default(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["openai_agents"])
    spans = run_and_collect(exporter)
    for span in spans:
        attrs = span.attributes or {}
        for key in attrs:
            assert not key.startswith(("openinference.", "llm.", "input.", "output.", "tool.")), (
                f"{span.name}: OpenInference key {key} survived"
            )
        assert [e for e in span.events if "message" in e.name or "choice" in e.name] == []


def test_capture_on_converts_content_to_events(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["openai_agents"], capture_content=True)
    spans = run_and_collect(exporter)

    final = next(
        c
        for c in by_operation(spans, "chat")
        if c.attributes and c.attributes["gen_ai.usage.input_tokens"] == ANSWER_TOKENS[0]
    )
    events = {e.name for e in final.events}
    assert "gen_ai.system.message" in events or "gen_ai.user.message" in events
    choice = next(e for e in final.events if e.name == "gen_ai.choice")
    assert choice.attributes is not None
    assert "Agents run complete." in str(choice.attributes["content"])
    assert final.attributes is not None
    assert not any(k.startswith("llm.") for k in final.attributes)

    (tool_span,) = by_operation(spans, "execute_tool")
    tool_events = {e.name: e for e in tool_span.events}
    args = tool_events["gen_ai.tool.message"].attributes
    assert args is not None and "otel genai" in str(args["content"])
    result = tool_events["gen_ai.choice"].attributes
    assert result is not None and "tracebloom.dev" in str(result["content"])


def test_variant_tag_flows_through_agents_spans(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["openai_agents"])
    with tracebloom.prompt_version("v2", "research"):
        spans = run_and_collect(exporter)
    assert spans
    for span in spans:
        assert span.attributes is not None
        assert span.attributes["gen_ai.prompt.version"] == "v2", span.name
