"""Agent and tool step tracing.

Multi-step agents are modeled with the OpenTelemetry GenAI span conventions: an
``invoke_agent`` span wraps a whole agent run (or a sub-agent delegation),
``execute_tool`` spans wrap individual tool executions, and any instrumented LLM
call made inside them nests automatically via OTel context propagation (which
also flows through ``async``/``await``). The trace viewer reconstructs the tree
from exactly this parent/child structure, so wrapping steps with these context
managers is all it takes to get a legible agent trace. Mirrors
``packages/sdk-ts/src/agent.ts``.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager

from opentelemetry.trace import Span, SpanKind, StatusCode

from .attributes import GenAIAttr, TraceBloomAttr
from .tracer import get_state

#: OTel-compatible primitive attribute values.
AttributeValue = str | int | float | bool


@contextmanager
def _gen_ai_span(span_name: str, attributes: dict[str, AttributeValue]) -> Iterator[Span]:
    """Shared wrapper: run the block inside an active span so nested
    LLM/tool/agent spans parent to it, mirror errors onto the span status
    (with the exception recorded as an event), and always end it.
    """
    tracer = get_state().tracer
    with tracer.start_as_current_span(
        span_name,
        kind=SpanKind.INTERNAL,
        attributes=attributes,
        record_exception=True,
        set_status_on_exception=True,
    ) as span:
        yield span
        # Only reached when the block did not raise; errors were already
        # recorded (and re-raised) by the context manager above.
        span.set_status(StatusCode.OK)


@contextmanager
def agent_span(
    name: str,
    *,
    agent_id: str | None = None,
    retry_attempt: int | None = None,
    attributes: Mapping[str, AttributeValue] | None = None,
) -> Iterator[Span]:
    """Trace an agent run (or sub-agent delegation) as an ``invoke_agent`` span.

    Every traced operation performed inside the block — LLM calls, tool
    executions, nested agents — becomes a child span of it::

        with tracebloom.agent_span("researcher"):
            plan = client.chat.completions.create(...)
            with tracebloom.tool_span("web.search"):
                results = search(query)

    Args:
        name: Agent name (``gen_ai.agent.name``), e.g. ``researcher``.
        agent_id: Stable agent identifier (``gen_ai.agent.id``).
        retry_attempt: 1-based attempt number; pass >= 2 when re-running a
            failed step.
        attributes: Extra span attributes (OTel-compatible primitive values).
    """
    attrs: dict[str, AttributeValue] = {
        GenAIAttr.OPERATION_NAME: "invoke_agent",
        GenAIAttr.AGENT_NAME: name,
    }
    if attributes:
        attrs.update(attributes)
    if agent_id is not None:
        attrs[GenAIAttr.AGENT_ID] = agent_id
    if retry_attempt is not None:
        attrs[TraceBloomAttr.RETRY_ATTEMPT] = retry_attempt
    with _gen_ai_span(f"invoke_agent {name}", attrs) as span:
        yield span


@contextmanager
def tool_span(
    name: str,
    *,
    call_id: str | None = None,
    description: str | None = None,
    retry_attempt: int | None = None,
    attributes: Mapping[str, AttributeValue] | None = None,
) -> Iterator[Span]:
    """Trace one tool execution as an ``execute_tool`` span.

    Raising from the block marks the span as an error and re-raises, so a retry
    loop around ``tool_span`` yields one span per attempt — pass
    ``retry_attempt`` to label the re-tries::

        for attempt in itertools.count(1):
            try:
                with tracebloom.tool_span("web.search", retry_attempt=attempt):
                    return run(query)
            except TransientError:
                if attempt >= MAX_ATTEMPTS:
                    raise

    Args:
        name: Tool name (``gen_ai.tool.name``), e.g. ``web.search``.
        call_id: Tool call id (``gen_ai.tool.call.id``) from the model's
            tool-call request.
        description: Tool description (``gen_ai.tool.description``) as
            advertised to the model.
        retry_attempt: 1-based attempt number; pass >= 2 when re-running a
            failed call.
        attributes: Extra span attributes (OTel-compatible primitive values).
    """
    attrs: dict[str, AttributeValue] = {
        GenAIAttr.OPERATION_NAME: "execute_tool",
        GenAIAttr.TOOL_NAME: name,
    }
    if attributes:
        attrs.update(attributes)
    if call_id is not None:
        attrs[GenAIAttr.TOOL_CALL_ID] = call_id
    if description is not None:
        attrs[GenAIAttr.TOOL_DESCRIPTION] = description
    if retry_attempt is not None:
        attrs[TraceBloomAttr.RETRY_ATTEMPT] = retry_attempt
    with _gen_ai_span(f"execute_tool {name}", attrs) as span:
        yield span
