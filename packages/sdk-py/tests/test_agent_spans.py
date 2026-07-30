"""Manual agent/tool spans: gen_ai attribute shape, parent/child structure the
M3 trace viewer renders, and error semantics."""

from __future__ import annotations

import pytest
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import StatusCode

import tracebloom
from tests.conftest import SdkFactory


def by_name(spans: tuple[ReadableSpan, ...], name: str) -> ReadableSpan:
    matches = [s for s in spans if s.name == name]
    assert len(matches) == 1, f"expected exactly one span named {name!r}"
    return matches[0]


def test_agent_span_attributes(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.agent_span(
        "researcher",
        agent_id="agent-1",
        retry_attempt=2,
        attributes={"team": "search"},
    ):
        pass
    span = by_name(exporter.get_finished_spans(), "invoke_agent researcher")
    assert span.attributes is not None
    assert span.attributes["gen_ai.operation.name"] == "invoke_agent"
    assert span.attributes["gen_ai.agent.name"] == "researcher"
    assert span.attributes["gen_ai.agent.id"] == "agent-1"
    assert span.attributes["tracebloom.retry.attempt"] == 2
    assert span.attributes["team"] == "search"
    assert span.status.status_code is StatusCode.OK


def test_tool_span_attributes(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.tool_span(
        "web.search",
        call_id="call-1",
        description="Search the public web",
    ):
        pass
    span = by_name(exporter.get_finished_spans(), "execute_tool web.search")
    assert span.attributes is not None
    assert span.attributes["gen_ai.operation.name"] == "execute_tool"
    assert span.attributes["gen_ai.tool.name"] == "web.search"
    assert span.attributes["gen_ai.tool.call.id"] == "call-1"
    assert span.attributes["gen_ai.tool.description"] == "Search the public web"


def test_nesting_produces_parent_child_tree(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.agent_span("researcher"):
        with tracebloom.tool_span("web.search"):
            pass
        with tracebloom.agent_span("summarizer"):
            with tracebloom.tool_span("web.fetch"):
                pass

    spans = exporter.get_finished_spans()
    root = by_name(spans, "invoke_agent researcher")
    search = by_name(spans, "execute_tool web.search")
    sub_agent = by_name(spans, "invoke_agent summarizer")
    fetch = by_name(spans, "execute_tool web.fetch")

    assert root.parent is None
    for child, parent in ((search, root), (sub_agent, root), (fetch, sub_agent)):
        assert child.parent is not None
        assert child.parent.span_id == parent.context.span_id
        assert child.context.trace_id == parent.context.trace_id


def test_error_marks_span_and_reraises(sdk: SdkFactory) -> None:
    exporter = sdk()
    with pytest.raises(ValueError, match="rate limited"):
        with tracebloom.tool_span("web.search"):
            raise ValueError("rate limited (429)")

    span = by_name(exporter.get_finished_spans(), "execute_tool web.search")
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description is not None
    assert "rate limited" in span.status.description
    exception_events = [e for e in span.events if e.name == "exception"]
    assert len(exception_events) == 1


def test_retry_loop_yields_one_span_per_attempt(sdk: SdkFactory) -> None:
    exporter = sdk()
    for attempt in (1, 2):
        try:
            with tracebloom.tool_span("web.search", retry_attempt=attempt):
                if attempt == 1:
                    raise ValueError("flaky")
        except ValueError:
            continue

    spans = [s for s in exporter.get_finished_spans() if s.name == "execute_tool web.search"]
    assert len(spans) == 2
    attempts = sorted(
        int(s.attributes["tracebloom.retry.attempt"])  # type: ignore[arg-type]
        for s in spans
        if s.attributes is not None
    )
    assert attempts == [1, 2]
