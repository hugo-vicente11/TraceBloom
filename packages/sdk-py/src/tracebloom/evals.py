"""Eval hooks: attach feedback/scores to spans from application code.

:func:`record_evaluation` emits the canonical OpenTelemetry
``gen_ai.evaluation.result`` event (the same shape the evaluation engine
stores — see DECISIONS.md D8) onto the active span. The collector persists it
in ``span_events``, and the eval runner promotes it into ``eval_results``
out-of-band, so SDK-recorded scores (human feedback, in-app heuristics,
guardrail verdicts) show up in the Evals view and the trace viewer exactly
like engine-computed ones. Mirrors ``packages/sdk-ts/src/evals.ts``.
"""

from __future__ import annotations

from typing import Final

from opentelemetry import trace
from opentelemetry.trace import Span

#: The canonical OTel event name for an evaluation result.
EVALUATION_RESULT_EVENT: Final = "gen_ai.evaluation.result"


class EvaluationAttr:
    """OTel ``gen_ai.evaluation.*`` (and related) attribute keys."""

    NAME: Final = "gen_ai.evaluation.name"
    SCORE_VALUE: Final = "gen_ai.evaluation.score.value"
    SCORE_LABEL: Final = "gen_ai.evaluation.score.label"
    EXPLANATION: Final = "gen_ai.evaluation.explanation"
    ERROR_TYPE: Final = "error.type"


def record_evaluation(
    name: str,
    *,
    score: float | None = None,
    label: str | None = None,
    reason: str | None = None,
    error_type: str | None = None,
    span: Span | None = None,
) -> None:
    """Record an evaluation result on the active span (or ``span``)::

        with tracebloom.agent_span("researcher"):
            answer = run_agent()
            tracebloom.record_evaluation("user_feedback", score=1.0, label="thumbs_up")

    Args:
        name: Stable metric name (``gen_ai.evaluation.name``).
        score: Normalized score in [0, 1]. Required unless ``error_type`` is set.
        label: Human-readable label, e.g. ``pass`` / ``fail`` / ``thumbs_up``.
        reason: Free-form rationale for the score.
        error_type: Set instead of ``score`` when the evaluation itself failed.
        span: Attach to this span instead of the active one.

    No-op when there is no active/recording span (like
    :func:`set_prompt_version`), so it is always safe to call. Raises
    ``ValueError`` when neither ``score`` nor ``error_type`` is given — that is
    a programming error, not a runtime condition.
    """
    if score is None and not error_type:
        raise ValueError("record_evaluation: either score or error_type is required")
    target = span if span is not None else trace.get_current_span()
    if not target.is_recording():
        return
    attributes: dict[str, str | float] = {EvaluationAttr.NAME: name}
    if error_type:
        attributes[EvaluationAttr.ERROR_TYPE] = error_type
    elif score is not None:
        attributes[EvaluationAttr.SCORE_VALUE] = score
        if label:
            attributes[EvaluationAttr.SCORE_LABEL] = label
    if reason:
        attributes[EvaluationAttr.EXPLANATION] = reason
    target.add_event(EVALUATION_RESULT_EVENT, attributes)
