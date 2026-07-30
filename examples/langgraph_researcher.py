"""Runnable example: a LangGraph researcher agent captured by TraceBloom.

One line — ``tracebloom.init(instrument=["langgraph"])`` — turns a real
LangGraph run into a live gen_ai trace: the graph nodes, the model calls, two
tool calls (search then fetch), and a deliberately refusing draft (so the
sample ``no-refusal`` eval flags it). The LLM is scripted in-process, so this
runs with no API key and no network to the model.

Prerequisites — the collector + ClickHouse + dashboard up (from the repo root)::

    pnpm stack:up            # collector + ClickHouse
    pnpm --filter @tracebloom/dashboard dev   # dashboard on :3000

Run it::

    uv run --project packages/sdk-py --extra langgraph \\
        python examples/langgraph_researcher.py

Then open the printed URL to watch the trace tree render.
"""

from __future__ import annotations

import os
import time
from typing import Annotated, Any, TypedDict

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

import tracebloom

MODEL = "gpt-4o-2024-08-06"
DASHBOARD_URL = os.environ.get("TRACEBLOOM_DASHBOARD_URL", "http://localhost:3000")


@tool
def web_search(query: str) -> str:
    """Search the public web for recent, citable sources."""
    return (
        "results: [tracebloom.dev/docs, github.com/open-telemetry/semantic-conventions]"
    )


@tool
def web_fetch(url: str) -> str:
    """Fetch and extract the readable text of a web page."""
    return (
        "OpenTelemetry GenAI defines gen_ai.* spans for agent runs, tools and models."
    )


class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def _scripted_model() -> GenericFakeChatModel:
    """A model that plans (search), reads a source (fetch), then refuses."""
    return GenericFakeChatModel(
        metadata={"ls_model_name": MODEL},
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "web_search",
                            "args": {"query": "otel genai agents"},
                            "id": "call-1",
                        }
                    ],
                    usage_metadata={
                        "input_tokens": 128,
                        "output_tokens": 20,
                        "total_tokens": 148,
                    },
                    response_metadata={"model_name": MODEL},
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "web_fetch",
                            "args": {"url": "https://tracebloom.dev/docs"},
                            "id": "call-2",
                        }
                    ],
                    usage_metadata={
                        "input_tokens": 176,
                        "output_tokens": 22,
                        "total_tokens": 198,
                    },
                    response_metadata={"model_name": MODEL},
                ),
                AIMessage(
                    content=(
                        "I cannot draft a confident answer: the fetched sources conflict and I "
                        "could not verify the key claims, so I am declining rather than guess."
                    ),
                    usage_metadata={
                        "input_tokens": 402,
                        "output_tokens": 54,
                        "total_tokens": 456,
                    },
                    response_metadata={"model_name": MODEL},
                ),
            ]
        ),
    )


def build_graph() -> Any:
    model = _scripted_model()

    def agent(state: State) -> State:
        return {"messages": [model.invoke(state["messages"])]}

    def route(state: State) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(State)
    graph.add_node("agent", agent)
    graph.add_node("tools", ToolNode([web_search, web_fetch]))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


def main() -> None:
    # Content capture ON so the span detail panel shows prompts/responses; the
    # variant tag groups these runs for the eval engine's A/B comparison.
    tracebloom.init(
        service_name="langgraph-example", capture_content=True, instrument=["langgraph"]
    )
    if "langgraph" not in tracebloom.get_state().instrumented:
        raise SystemExit(
            "LangGraph instrumentation did not load. Install the extra:\n"
            "  uv run --project packages/sdk-py --extra langgraph ..."
        )

    app = build_graph()
    with tracebloom.prompt_version("v1", "research"):
        result = app.invoke(
            {
                "messages": [
                    HumanMessage(
                        content="how do teams monitor LLM agents in production?"
                    )
                ]
            }
        )
    print("agent said:", result["messages"][-1].content[:80], "…")

    tracebloom.shutdown()  # flush the exporter
    time.sleep(1.0)
    print(
        f"\n▶ Open {DASHBOARD_URL}/traces and click the newest 'langgraph-example' trace."
    )


if __name__ == "__main__":
    main()
