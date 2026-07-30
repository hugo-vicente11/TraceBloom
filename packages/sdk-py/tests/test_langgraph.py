"""LangChain + LangGraph integration: a real LangGraph agent run (scripted
chat model, prebuilt ToolNode, conditional edges — no network, no keys)
captured through the Traceloop-published LangChain instrumentation and adapted
at the edge by the TraceBloom span processor.

What must hold (the M7 contract): the run renders as a correctly-nested
gen_ai tree (invoke_agent → graph-node execute_task → chat / execute_tool),
cost comes from the shared pricing map, the content toggle governs every
content-bearing key the instrumentation emits, and variant tagging + eval
hooks flow through framework spans exactly like hand-written ones.
"""

from __future__ import annotations

from typing import Annotated, Any, TypedDict

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import tracebloom
from tests.conftest import SdkFactory

MODEL = "gpt-4o-2024-08-06"
PLAN_TOKENS = (120, 18)
ANSWER_TOKENS = (240, 12)


@tool
def web_search(query: str) -> str:
    """Search the public web."""
    return "results: tracebloom.dev"


class _State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def run_graph(record_eval: bool = False) -> None:
    """One agent turn: model requests web_search, ToolNode runs it, model answers.

    The scripted fake advertises its model name the way LangChain models do at
    runtime — ``ls_model_name`` metadata (the serialized-kwargs path the
    instrumentation prefers only exists for lc-serializable models).
    """
    model = GenericFakeChatModel(
        metadata={"ls_model_name": MODEL},
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "web_search", "args": {"query": "otel genai"}, "id": "call-1"}
                    ],
                    usage_metadata={
                        "input_tokens": PLAN_TOKENS[0],
                        "output_tokens": PLAN_TOKENS[1],
                        "total_tokens": sum(PLAN_TOKENS),
                    },
                    response_metadata={"model_name": MODEL},
                ),
                AIMessage(
                    content="LangGraph run complete.",
                    usage_metadata={
                        "input_tokens": ANSWER_TOKENS[0],
                        "output_tokens": ANSWER_TOKENS[1],
                        "total_tokens": sum(ANSWER_TOKENS),
                    },
                    response_metadata={"model_name": MODEL},
                ),
            ]
        ),
    )

    def agent(state: _State) -> _State:
        if record_eval:
            tracebloom.record_evaluation("step_quality", score=0.9, label="pass")
        return {"messages": [model.invoke(state["messages"])]}

    def route(state: _State) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(_State)
    graph.add_node("agent", agent)
    graph.add_node("tools", ToolNode([web_search]))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    graph.compile().invoke({"messages": [HumanMessage(content="find otel genai news")]})


def spans_by_operation(spans: tuple[ReadableSpan, ...], operation: str) -> list[ReadableSpan]:
    return [
        s
        for s in spans
        if s.attributes is not None and s.attributes.get("gen_ai.operation.name") == operation
    ]


def run_and_collect(exporter: InMemorySpanExporter, **kwargs: Any) -> tuple[ReadableSpan, ...]:
    run_graph(**kwargs)
    return exporter.get_finished_spans()


def test_langgraph_run_produces_conformant_agent_tree(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langgraph"])
    assert tracebloom.get_state().instrumented == ("langgraph",)
    spans = run_and_collect(exporter)

    (root,) = [s for s in spans if s.parent is None]
    assert root.attributes is not None
    assert root.attributes["gen_ai.operation.name"] == "invoke_agent"
    assert root.attributes["gen_ai.agent.name"] == "LangGraph"
    assert all(s.context.trace_id == root.context.trace_id for s in spans)

    # Graph nodes appear as execute_task spans named after the node.
    tasks = spans_by_operation(spans, "execute_task")
    task_names = {s.attributes.get("gen_ai.task.name") for s in tasks if s.attributes}
    assert {"agent", "tools"} <= task_names

    # The tool execution nests under the "tools" graph node.
    (tool_span,) = spans_by_operation(spans, "execute_tool")
    assert tool_span.attributes is not None
    assert tool_span.attributes["gen_ai.tool.name"] == "web_search"
    by_id = {s.context.span_id: s for s in spans}
    assert tool_span.parent is not None
    tool_parent = by_id[tool_span.parent.span_id]
    assert tool_parent.attributes is not None
    assert tool_parent.attributes.get("gen_ai.task.name") == "tools"

    # Both chat spans nest under the "agent" graph node and carry model + usage.
    chats = spans_by_operation(spans, "chat")
    assert len(chats) == 2
    for chat in chats:
        assert chat.attributes is not None
        assert chat.attributes["gen_ai.request.model"] == MODEL
        assert chat.parent is not None
        chat_parent = by_id[chat.parent.span_id]
        assert chat_parent.attributes is not None
        assert chat_parent.attributes.get("gen_ai.task.name") == "agent"
    assert {c.attributes["gen_ai.usage.input_tokens"] for c in chats if c.attributes} == {
        PLAN_TOKENS[0],
        ANSWER_TOKENS[0],
    }


def test_framework_chat_cost_comes_from_shared_pricing(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langgraph"])
    spans = run_and_collect(exporter)
    chats = spans_by_operation(spans, "chat")
    plan = next(
        c for c in chats if c.attributes and c.attributes["gen_ai.usage.input_tokens"] == 120
    )
    expected = tracebloom.compute_cost(MODEL, *PLAN_TOKENS)
    assert plan.attributes is not None
    assert plan.attributes["tracebloom.cost.input_usd"] == expected.input_usd
    assert plan.attributes["tracebloom.cost.output_usd"] == expected.output_usd
    assert plan.attributes["tracebloom.cost.total_usd"] == expected.total_usd


def test_content_stripped_everywhere_by_default(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langgraph"])
    spans = run_and_collect(exporter)
    for span in spans:
        attrs = span.attributes or {}
        for key in attrs:
            assert not key.startswith("traceloop."), f"{span.name}: vendor key {key} survived"
        for forbidden in (
            "gen_ai.input.messages",
            "gen_ai.output.messages",
            "gen_ai.task.input",
            "gen_ai.task.output",
            "gen_ai.tool.call.arguments",
            "gen_ai.tool.call.result",
        ):
            assert forbidden not in attrs, f"{span.name}: content attr {forbidden} survived"
        assert [e for e in span.events if "message" in e.name or "choice" in e.name] == []


def test_capture_on_converts_framework_content_to_events(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langgraph"], capture_content=True)
    spans = run_and_collect(exporter)

    answer = next(
        c
        for c in spans_by_operation(spans, "chat")
        if c.attributes and c.attributes["gen_ai.usage.input_tokens"] == ANSWER_TOKENS[0]
    )
    events = {event.name: event for event in answer.events}
    user = events["gen_ai.user.message"].attributes
    assert user is not None and "find otel genai news" in str(user["content"])
    choice = events["gen_ai.choice"].attributes
    assert choice is not None and "LangGraph run complete." in str(choice["content"])
    # Content never remains an attribute, even with capture on (D2).
    assert answer.attributes is not None
    assert "gen_ai.input.messages" not in answer.attributes

    (tool_span,) = spans_by_operation(spans, "execute_tool")
    tool_events = {event.name: event for event in tool_span.events}
    arguments = tool_events["gen_ai.tool.message"].attributes
    assert arguments is not None and "otel genai" in str(arguments["content"])
    result = tool_events["gen_ai.choice"].attributes
    assert result is not None and "tracebloom.dev" in str(result["content"])

    # Graph-node payloads (run state) are dropped, not converted.
    for task in spans_by_operation(spans, "execute_task"):
        assert [e for e in task.events if "message" in e.name or "choice" in e.name] == []


def test_variant_tag_and_eval_hook_flow_through_framework_spans(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langgraph"])
    with tracebloom.prompt_version("v2", "research"):
        spans = run_and_collect(exporter, record_eval=True)

    for span in spans:
        assert span.attributes is not None
        assert span.attributes["gen_ai.prompt.version"] == "v2", span.name

    # record_evaluation inside a graph node lands on that node's task span.
    agent_tasks = [
        s
        for s in spans_by_operation(spans, "execute_task")
        if s.attributes and s.attributes.get("gen_ai.task.name") == "agent"
    ]
    eval_events = [e for s in agent_tasks for e in s.events if e.name == "gen_ai.evaluation.result"]
    assert eval_events, "evaluation event missing from the graph-node span"
    assert eval_events[0].attributes is not None
    assert eval_events[0].attributes["gen_ai.evaluation.name"] == "step_quality"
    assert eval_events[0].attributes["gen_ai.evaluation.score.value"] == 0.9


def test_langchain_and_langgraph_names_share_one_instrumentor(sdk: SdkFactory) -> None:
    exporter = sdk(instrument=["langchain", "langgraph"])
    assert tracebloom.get_state().instrumented == ("langchain", "langgraph")
    spans = run_and_collect(exporter)
    # One handler, not two: the run yields exactly 2 chat spans, not 4.
    assert len(spans_by_operation(spans, "chat")) == 2
