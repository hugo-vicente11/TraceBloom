"""End-to-end integration: Python SDK → real collector → ClickHouse.

Runs only when a collector + ClickHouse are reachable (CI starts them; locally
``pnpm stack:up``):

    TRACEBLOOM_TEST_COLLECTOR_URL=http://localhost:4318 \\
    TRACEBLOOM_TEST_CLICKHOUSE_URL=http://localhost:8123 uv run pytest tests/integration

The LLM call goes through the real ``openai`` client + real OTel
instrumentation with a mocked HTTP transport — no network beyond
collector/ClickHouse, no API key.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

import httpx
import openai
import pytest

import tracebloom

COLLECTOR_URL = os.environ.get("TRACEBLOOM_TEST_COLLECTOR_URL")
CLICKHOUSE_URL = os.environ.get("TRACEBLOOM_TEST_CLICKHOUSE_URL")
DATABASE = os.environ.get("CLICKHOUSE_DATABASE", "tracebloom")

pytestmark = pytest.mark.skipif(
    not (COLLECTOR_URL and CLICKHOUSE_URL),
    reason="set TRACEBLOOM_TEST_COLLECTOR_URL and TRACEBLOOM_TEST_CLICKHOUSE_URL to run",
)

OPENAI_RESPONSE: dict[str, Any] = {
    "id": "chatcmpl-integration",
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


def clickhouse_rows(query: str) -> list[dict[str, Any]]:
    assert CLICKHOUSE_URL is not None
    response = httpx.get(
        CLICKHOUSE_URL, params={"query": f"{query} FORMAT JSONEachRow"}, timeout=10.0
    )
    response.raise_for_status()
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def wait_for_rows(query: str, minimum: int, timeout_s: float = 20.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        rows = clickhouse_rows(query)
        if len(rows) >= minimum:
            return rows
        time.sleep(0.5)
    return rows


def test_agent_trace_lands_in_clickhouse() -> None:
    service = f"sdk-py-integration-{uuid.uuid4().hex[:8]}"
    tracebloom.init(
        endpoint=COLLECTOR_URL,
        service_name=service,
        capture_content=True,
    )
    client = openai.OpenAI(
        api_key="mock-key",
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=OPENAI_RESPONSE))
        ),
    )

    try:
        with tracebloom.agent_span("researcher", agent_id="agent-1") as root:
            trace_id = f"{root.get_span_context().trace_id:032x}"
            with tracebloom.prompt_version("v2", "research"):
                client.chat.completions.create(
                    model="gpt-4o",
                    messages=[{"role": "user", "content": "plan the research"}],
                )
            with tracebloom.tool_span("web.search", call_id="call-1"):
                pass
            tracebloom.record_evaluation("user_feedback", score=1.0, label="thumbs_up")
    finally:
        tracebloom.shutdown()

    spans = wait_for_rows(
        "SELECT span_id, parent_span_id, name, operation_name, provider, request_model,"
        " input_tokens, output_tokens, cost_usd, attributes_json"
        f" FROM {DATABASE}.spans WHERE trace_id = '{trace_id}'",
        minimum=3,
    )
    by_name = {row["name"]: row for row in spans}
    assert set(by_name) == {"invoke_agent researcher", "chat gpt-4o", "execute_tool web.search"}

    root_row = by_name["invoke_agent researcher"]
    llm = by_name["chat gpt-4o"]
    tool = by_name["execute_tool web.search"]
    assert root_row["parent_span_id"] == ""
    assert llm["parent_span_id"] == root_row["span_id"]
    assert tool["parent_span_id"] == root_row["span_id"]

    # gen_ai promotion + cost from the shared pricing map.
    assert llm["operation_name"] == "chat"
    assert llm["provider"] == "openai"
    assert llm["request_model"] == "gpt-4o"
    assert llm["input_tokens"] == 138
    assert llm["output_tokens"] == 61
    expected = tracebloom.compute_cost("gpt-4o-2024-08-06", 138, 61)
    assert llm["cost_usd"] == pytest.approx(expected.total_usd)
    # Variant tag rode the contextvar onto the auto-instrumented span.
    llm_attrs = json.loads(llm["attributes_json"])
    assert llm_attrs["gen_ai.prompt.version"] == "v2"
    # Content never lands in span attributes (D2).
    assert "gen_ai.input.messages" not in llm_attrs
    assert "gen_ai.output.messages" not in llm_attrs

    events = wait_for_rows(
        f"SELECT span_id, name, body FROM {DATABASE}.span_events WHERE trace_id = '{trace_id}'",
        minimum=3,
    )
    llm_events = {row["name"] for row in events if row["span_id"] == llm["span_id"]}
    assert {"gen_ai.user.message", "gen_ai.choice"} <= llm_events
    choice_body = next(
        json.loads(row["body"])
        for row in events
        if row["span_id"] == llm["span_id"] and row["name"] == "gen_ai.choice"
    )
    assert choice_body["content"] == "the plan"

    eval_events = [row for row in events if row["name"] == "gen_ai.evaluation.result"]
    assert len(eval_events) == 1
    eval_body = json.loads(eval_events[0]["body"])
    assert eval_body["gen_ai.evaluation.name"] == "user_feedback"
    assert eval_body["gen_ai.evaluation.score.value"] == 1.0
