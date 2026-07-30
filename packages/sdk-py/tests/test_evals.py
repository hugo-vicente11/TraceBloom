"""Eval hook: the canonical gen_ai.evaluation.result event shape (D8)."""

from __future__ import annotations

import pytest

import tracebloom
from tests.conftest import SdkFactory


def test_emits_canonical_evaluation_result_event(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.tool_span("answer"):
        tracebloom.record_evaluation(
            "user_feedback", score=1.0, label="thumbs_up", reason="helpful"
        )

    (span,) = exporter.get_finished_spans()
    events = [e for e in span.events if e.name == "gen_ai.evaluation.result"]
    assert len(events) == 1
    assert dict(events[0].attributes or {}) == {
        "gen_ai.evaluation.name": "user_feedback",
        "gen_ai.evaluation.score.value": 1.0,
        "gen_ai.evaluation.score.label": "thumbs_up",
        "gen_ai.evaluation.explanation": "helpful",
    }


def test_errored_evaluation_has_error_type_and_no_score(sdk: SdkFactory) -> None:
    exporter = sdk()
    with tracebloom.tool_span("answer"):
        tracebloom.record_evaluation("toxicity", score=0.4, error_type="timeout")

    (span,) = exporter.get_finished_spans()
    (event,) = [e for e in span.events if e.name == "gen_ai.evaluation.result"]
    assert dict(event.attributes or {}) == {
        "gen_ai.evaluation.name": "toxicity",
        "error.type": "timeout",
    }


def test_no_active_span_is_a_safe_no_op(sdk: SdkFactory) -> None:
    sdk()
    tracebloom.record_evaluation("user_feedback", score=0.5)


def test_requires_score_or_error_type(sdk: SdkFactory) -> None:
    sdk()
    with pytest.raises(ValueError, match="score or error_type"):
        tracebloom.record_evaluation("user_feedback")
