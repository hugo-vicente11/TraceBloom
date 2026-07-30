"""End-to-end integration: framework agent → real collector → ClickHouse.

For each Python framework integration (LangGraph, LlamaIndex, OpenAI Agents),
run the same scripted agent the unit tests use — but through the real OTLP
pipeline — and assert the run lands as a correct, coherent gen_ai tree: one
invoke_agent root, exactly two chat spans with model + usage + shared-pricing
cost, a tool execution, all in one trace, with no vendor/content keys leaking
and (capture on) content promoted to span events. The Vercel AI SDK path is
covered end-to-end by the try-it sandbox in infra/prod/smoke.sh.

Runs only when a collector + ClickHouse are reachable (CI starts them; locally
``pnpm stack:up``); mocked LLMs throughout — no network beyond the collector,
no API keys.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

import tracebloom
from tests.integration.test_pipeline import COLLECTOR_URL, DATABASE, wait_for_rows
from tests.test_langgraph import MODEL as LANGGRAPH_MODEL
from tests.test_langgraph import run_graph
from tests.test_llamaindex import MODEL as LLAMAINDEX_MODEL
from tests.test_llamaindex import run_agent as run_llamaindex
from tests.test_openai_agents import MODEL as AGENTS_MODEL
from tests.test_openai_agents import run_agent as run_openai_agents

pytestmark = pytest.mark.skipif(
    not COLLECTOR_URL,
    reason="set TRACEBLOOM_TEST_COLLECTOR_URL and TRACEBLOOM_TEST_CLICKHOUSE_URL to run",
)

FRAMEWORKS: list[tuple[str, Callable[[], None], str]] = [
    ("langgraph", run_graph, LANGGRAPH_MODEL),
    ("llama_index", run_llamaindex, LLAMAINDEX_MODEL),
    ("openai_agents", run_openai_agents, AGENTS_MODEL),
]
FRAMEWORK_IDS = [name for name, _, _ in FRAMEWORKS]

_VENDOR_OR_CONTENT_KEYS = (
    "traceloop.",
    "openinference.",
    "llm.",
    "input.value",
    "output.value",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.task.input",
)


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_framework_run_lands_as_tree_in_clickhouse(
    instrument: str, run: Callable[[], None], model: str
) -> None:
    service = f"sdk-py-{instrument}-{uuid.uuid4().hex[:8]}"
    tracebloom.init(
        endpoint=COLLECTOR_URL, service_name=service, capture_content=True, instrument=[instrument]
    )
    assert instrument in tracebloom.get_state().instrumented
    try:
        with tracebloom.prompt_version("v2", "research"):
            run()
    finally:
        tracebloom.shutdown()  # flush the batch exporter

    # tool_name / prompt_version live in attributes_json, extract them the way
    # the dashboard's trace query does (packages ship no promoted columns for them).
    spans = wait_for_rows(
        "SELECT span_id, parent_span_id, trace_id, operation_name, request_model,"
        " input_tokens, output_tokens, cost_usd,"
        " JSONExtractString(attributes_json, 'gen_ai.tool.name') AS tool_name,"
        " JSONExtractString(attributes_json, 'gen_ai.prompt.version') AS prompt_version,"
        " attributes_json"
        f" FROM {DATABASE}.spans WHERE service_name = '{service}'",
        minimum=4,
    )
    assert len(spans) >= 4, f"{instrument}: only {len(spans)} spans landed"

    # One trace, one invoke_agent root.
    assert len({row["trace_id"] for row in spans}) == 1
    roots = [row for row in spans if row["parent_span_id"] == ""]
    assert len(roots) == 1, f"{instrument}: expected one root, got {len(roots)}"
    assert roots[0]["operation_name"] == "invoke_agent"

    # Every span carries the variant tag and no vendor/content keys.
    for row in spans:
        assert row["prompt_version"] == "v2", f"{instrument}: {row['operation_name']} untagged"
        for key in _VENDOR_OR_CONTENT_KEYS:
            assert key not in row["attributes_json"], f"{instrument}: leaked {key}"

    # Two model calls, canonical chat shape with shared-pricing cost.
    chats = [row for row in spans if row["operation_name"] == "chat"]
    assert len(chats) == 2, f"{instrument}: expected 2 chat spans, got {len(chats)}"
    for chat in chats:
        assert chat["request_model"] == model
        assert chat["input_tokens"] > 0 and chat["output_tokens"] > 0
        expected = tracebloom.compute_cost(model, chat["input_tokens"], chat["output_tokens"])
        assert chat["cost_usd"] == pytest.approx(expected.total_usd)

    # The tool execution is captured and nests inside the trace.
    tools = [row for row in spans if row["operation_name"] == "execute_tool"]
    assert tools, f"{instrument}: no execute_tool span"
    assert all(row["tool_name"] for row in tools)

    # Capture on: content rode the pipeline as span events, not attributes.
    events = wait_for_rows(
        f"SELECT span_id, name FROM {DATABASE}.span_events"
        f" WHERE trace_id = '{roots[0]['trace_id']}' AND name = 'gen_ai.choice'",
        minimum=1,
    )
    assert events, f"{instrument}: no gen_ai.choice events (capture on)"
