"""LlamaIndex integration: a real ReActAgent workflow run (scripted LLM,
FunctionTool — no network, no keys) captured through the OpenInference
LlamaIndex instrumentation (built on LlamaIndex's native instrumentation
dispatcher) and rewritten to canonical gen_ai at the edge.

Same M7 contract as test_langgraph.py: correct tree, shared-pricing cost,
content toggle over every OpenInference content key, variant tagging.
"""

from __future__ import annotations

import asyncio
from typing import Any

from llama_index.core.agent.workflow import ReActAgent
from llama_index.core.llms import (
    ChatMessage,
    ChatResponse,
    ChatResponseAsyncGen,
    ChatResponseGen,
    CompletionResponse,
    CompletionResponseGen,
    CustomLLM,
    LLMMetadata,
)
from llama_index.core.llms.callbacks import llm_chat_callback, llm_completion_callback
from llama_index.core.tools import FunctionTool
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import tracebloom
from tests.conftest import SdkFactory

MODEL = "gpt-4o-2024-08-06"
STEP_TOKENS = (100, 20)

_SEARCH_STEP = (
    'Thought: I need to search.\nAction: web_search\nAction Input: {"query": "otel genai"}'
)
_ANSWER_STEP = "Thought: I can answer.\nAnswer: LlamaIndex run complete."


class ScriptedLLM(CustomLLM):
    """Chat model scripted to request the search tool once, then answer.

    ``astream_chat`` is implemented directly (single scripted chunk) so each
    agent step produces exactly one LLM span — the CustomLLM fallback chain
    (astream → stream → chat) would nest three.
    """

    calls: int = 0

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(model_name=MODEL, is_function_calling_model=False)

    def _respond(self) -> ChatResponse:
        self.calls += 1
        content = _SEARCH_STEP if self.calls == 1 else _ANSWER_STEP
        return ChatResponse(
            message=ChatMessage(role="assistant", content=content),
            additional_kwargs={
                "prompt_tokens": STEP_TOKENS[0],
                "completion_tokens": STEP_TOKENS[1],
                "total_tokens": sum(STEP_TOKENS),
            },
        )

    @llm_chat_callback()
    def chat(self, messages: Any, **kwargs: Any) -> ChatResponse:
        return self._respond()

    @llm_chat_callback()
    async def astream_chat(self, messages: Any, **kwargs: Any) -> ChatResponseAsyncGen:
        response = self._respond()

        async def gen() -> ChatResponseAsyncGen:
            yield ChatResponse(
                message=response.message,
                delta=response.message.content or "",
                additional_kwargs=response.additional_kwargs,
            )

        return gen()

    @llm_completion_callback()
    def complete(self, prompt: str, formatted: bool = False, **kwargs: Any) -> CompletionResponse:
        raise NotImplementedError

    def stream_complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponseGen:
        raise NotImplementedError

    def stream_chat(self, messages: Any, **kwargs: Any) -> ChatResponseGen:
        raise NotImplementedError


def web_search(query: str) -> str:
    """Search the public web."""
    return "results: tracebloom.dev"


def run_agent() -> None:
    agent = ReActAgent(
        name="researcher",
        tools=[FunctionTool.from_defaults(fn=web_search)],
        llm=ScriptedLLM(),
    )
    asyncio.run(_run(agent))


async def _run(agent: ReActAgent) -> None:
    await agent.run(user_msg="find otel genai news")


def by_operation(spans: tuple[ReadableSpan, ...], operation: str) -> list[ReadableSpan]:
    return [
        s
        for s in spans
        if s.attributes is not None and s.attributes.get("gen_ai.operation.name") == operation
    ]


def run_and_collect(exporter: InMemorySpanExporter) -> tuple[ReadableSpan, ...]:
    run_agent()
    return exporter.get_finished_spans()


def test_llamaindex_run_produces_conformant_agent_tree(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["llama_index"])
    assert tracebloom.get_state().instrumented == ("llama_index",)
    spans = run_and_collect(exporter)

    (root,) = [s for s in spans if s.parent is None]
    assert root.attributes is not None
    assert root.attributes["gen_ai.operation.name"] == "invoke_agent"
    assert root.attributes["gen_ai.agent.name"] == "ReActAgent"
    assert root.name == "invoke_agent ReActAgent"
    assert all(s.context.trace_id == root.context.trace_id for s in spans)

    # Workflow steps map to execute_task, named after the framework step.
    tasks = by_operation(spans, "execute_task")
    assert tasks, "workflow steps missing"
    task_names = {s.attributes.get("gen_ai.task.name") for s in tasks if s.attributes}
    assert any("run_agent_step" in str(n) for n in task_names)

    # Exactly one LLM span per agent step, in canonical chat shape.
    chats = by_operation(spans, "chat")
    assert len(chats) == 2
    for chat in chats:
        assert chat.attributes is not None
        assert chat.name == f"chat {MODEL}"
        assert chat.attributes["gen_ai.request.model"] == MODEL
        assert chat.attributes["gen_ai.usage.input_tokens"] == STEP_TOKENS[0]
        assert chat.attributes["gen_ai.usage.output_tokens"] == STEP_TOKENS[1]

    (tool_span,) = by_operation(spans, "execute_tool")
    assert tool_span.attributes is not None
    assert tool_span.attributes["gen_ai.tool.name"] == "web_search"
    assert tool_span.name == "execute_tool web_search"
    # The tool execution nests inside the run, under a workflow step.
    by_id = {s.context.span_id: s for s in spans}
    assert tool_span.parent is not None
    parent = by_id[tool_span.parent.span_id]
    assert parent.attributes is not None
    assert parent.attributes.get("gen_ai.operation.name") == "execute_task"


def test_llamaindex_chat_cost_comes_from_shared_pricing(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["llama_index"])
    spans = run_and_collect(exporter)
    expected = tracebloom.compute_cost(MODEL, *STEP_TOKENS)
    for chat in by_operation(spans, "chat"):
        assert chat.attributes is not None
        assert chat.attributes["tracebloom.cost.input_usd"] == expected.input_usd
        assert chat.attributes["tracebloom.cost.output_usd"] == expected.output_usd
        assert chat.attributes["tracebloom.cost.total_usd"] == expected.total_usd


def test_openinference_content_stripped_everywhere_by_default(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["llama_index"])
    spans = run_and_collect(exporter)
    for span in spans:
        attrs = span.attributes or {}
        for key in attrs:
            assert not key.startswith(
                ("openinference.", "llm.", "input.", "output.", "tool.", "retrieval.")
            ), f"{span.name}: OpenInference key {key} survived"
        assert [e for e in span.events if "message" in e.name or "choice" in e.name] == []


def test_capture_on_converts_openinference_content_to_events(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["llama_index"], capture_content=True)
    spans = run_and_collect(exporter)

    final_chat = by_operation(spans, "chat")[-1]
    events = [e for e in final_chat.events]
    roles = {e.name for e in events}
    assert "gen_ai.user.message" in roles or "gen_ai.system.message" in roles
    choice = next(e for e in events if e.name == "gen_ai.choice")
    assert choice.attributes is not None
    assert "LlamaIndex run complete." in str(choice.attributes["content"])
    assert final_chat.attributes is not None
    assert not any(k.startswith("llm.") for k in final_chat.attributes)

    (tool_span,) = by_operation(spans, "execute_tool")
    tool_events = {e.name: e for e in tool_span.events}
    arguments = tool_events["gen_ai.tool.message"].attributes
    assert arguments is not None and "otel genai" in str(arguments["content"])
    result = tool_events["gen_ai.choice"].attributes
    assert result is not None and "tracebloom.dev" in str(result["content"])


def test_variant_tag_flows_through_llamaindex_spans(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["llama_index"])
    with tracebloom.prompt_version("v2", "research"):
        spans = run_and_collect(exporter)
    for span in spans:
        assert span.attributes is not None
        assert span.attributes["gen_ai.prompt.version"] == "v2", span.name
