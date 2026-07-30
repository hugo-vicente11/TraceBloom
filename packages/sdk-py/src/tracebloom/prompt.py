"""Prompt version / variant tagging.

The evaluation engine compares score distributions across *variants* — a
variant being a ``gen_ai.prompt.version`` label (falling back to the request
model). Tagging that label on a span is how you tell TraceBloom "these traces
came from prompt v2" so an A/B or regression check can line them up. The keys
are the OpenTelemetry ``gen_ai.prompt.*`` semantic-convention attributes.
Mirrors ``packages/sdk-ts/src/prompt.ts``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from opentelemetry import trace

from .attributes import GenAIAttr


@dataclass(frozen=True)
class PromptTag:
    """Prompt tagging applied to spans (``gen_ai.prompt.version`` / ``.name``)."""

    version: str
    name: str | None = None


_active_tag: ContextVar[PromptTag | None] = ContextVar("tracebloom_prompt_tag", default=None)


def set_prompt_version(version: str, name: str | None = None) -> None:
    """Tag the currently active span with a prompt version (and optional
    template name). Call this inside a traced operation::

        with tracebloom.tool_span("summarize"):
            tracebloom.set_prompt_version("v2", "summarize")
            ...

    No-op when there is no active/recording span, so it is always safe to call.
    """
    span = trace.get_current_span()
    if not span.is_recording():
        return
    span.set_attribute(GenAIAttr.PROMPT_VERSION, version)
    if name is not None:
        span.set_attribute(GenAIAttr.PROMPT_NAME, name)


@contextmanager
def prompt_version(version: str, name: str | None = None) -> Iterator[None]:
    """Tag every span started inside the block — including auto-instrumented
    OpenAI/Anthropic spans — with ``gen_ai.prompt.version`` (and ``.name``).

    This is the Python analogue of the TS SDK's per-client tag
    (``instrumentOpenAI(client, { promptVersion })``): auto-instrumented calls
    can't take extra arguments, so the tag rides the OTel context instead
    (contextvars, so it is async-safe)::

        with tracebloom.prompt_version("v2", "research"):
            client.chat.completions.create(...)  # span tagged with v2
    """
    token = _active_tag.set(PromptTag(version=version, name=name))
    try:
        yield
    finally:
        _active_tag.reset(token)


def active_prompt_tag() -> PromptTag | None:
    """Internal: the prompt tag for spans starting in the current context."""
    return _active_tag.get()
