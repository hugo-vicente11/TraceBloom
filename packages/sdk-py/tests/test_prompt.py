"""Variant tagging: set_prompt_version on the active span and the
prompt_version context manager stamping auto-instrumented spans."""

from __future__ import annotations

import tracebloom
from tests.conftest import SdkFactory


def test_set_prompt_version_tags_active_span(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.tool_span("summarize"):
        tracebloom.set_prompt_version("v2", "summarize")
    (span,) = exporter.get_finished_spans()
    assert span.attributes is not None
    assert span.attributes["gen_ai.prompt.version"] == "v2"
    assert span.attributes["gen_ai.prompt.name"] == "summarize"


def test_set_prompt_version_without_active_span_is_safe() -> None:
    tracebloom.set_prompt_version("v2")


def test_prompt_version_context_tags_spans_started_inside(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.prompt_version("v2", "research"):
        with tracebloom.tool_span("web.search"):
            pass
    with tracebloom.tool_span("untagged"):
        pass

    spans = {span.name: span for span in exporter.get_finished_spans()}
    tagged = spans["execute_tool web.search"].attributes
    assert tagged is not None
    assert tagged["gen_ai.prompt.version"] == "v2"
    assert tagged["gen_ai.prompt.name"] == "research"
    untagged = spans["execute_tool untagged"].attributes
    assert untagged is not None
    assert "gen_ai.prompt.version" not in untagged


def test_explicit_span_attribute_wins_over_context_tag(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.prompt_version("context-version"):
        with tracebloom.tool_span("t", attributes={"gen_ai.prompt.version": "explicit"}):
            pass
    (span,) = exporter.get_finished_spans()
    assert span.attributes is not None
    assert span.attributes["gen_ai.prompt.version"] == "explicit"
