"""Attribute and event keys from the OpenTelemetry GenAI semantic conventions
(the ``gen_ai.*`` namespace), plus TraceBloom's small set of extension keys.

We use the canonical string keys directly rather than importing constants from
``opentelemetry-semantic-conventions``, because the GenAI conventions are still
experimental and the exported constant *names* churn between releases while the
wire keys are stable. The keys here ARE the convention, and they mirror
``packages/sdk-ts/src/attributes.ts`` exactly.
"""

from __future__ import annotations

from typing import Final


class GenAIAttr:
    """OpenTelemetry ``gen_ai.*`` semantic-convention attribute keys."""

    OPERATION_NAME: Final = "gen_ai.operation.name"
    #: Provider id, e.g. ``openai``. Renamed from ``gen_ai.system`` in newer specs.
    PROVIDER_NAME: Final = "gen_ai.provider.name"
    REQUEST_MODEL: Final = "gen_ai.request.model"
    REQUEST_TEMPERATURE: Final = "gen_ai.request.temperature"
    REQUEST_TOP_P: Final = "gen_ai.request.top_p"
    REQUEST_MAX_TOKENS: Final = "gen_ai.request.max_tokens"
    RESPONSE_MODEL: Final = "gen_ai.response.model"
    RESPONSE_ID: Final = "gen_ai.response.id"
    RESPONSE_FINISH_REASONS: Final = "gen_ai.response.finish_reasons"
    USAGE_INPUT_TOKENS: Final = "gen_ai.usage.input_tokens"
    USAGE_OUTPUT_TOKENS: Final = "gen_ai.usage.output_tokens"
    #: Name of a named prompt template, e.g. ``summarize-v2``.
    PROMPT_NAME: Final = "gen_ai.prompt.name"
    #: Version/variant label of the prompt template, e.g. ``1.0.0``, ``prod``, ``v2``.
    PROMPT_VERSION: Final = "gen_ai.prompt.version"
    #: Human-readable agent name, e.g. ``researcher``.
    AGENT_NAME: Final = "gen_ai.agent.name"
    #: Unique agent identifier, when the framework assigns one.
    AGENT_ID: Final = "gen_ai.agent.id"
    #: Name of the tool being executed, e.g. ``web.search``.
    TOOL_NAME: Final = "gen_ai.tool.name"
    #: Tool call id correlating the execution with the model's tool-call request.
    TOOL_CALL_ID: Final = "gen_ai.tool.call.id"
    #: Tool description as advertised to the model.
    TOOL_DESCRIPTION: Final = "gen_ai.tool.description"


class TraceBloomAttr:
    """TraceBloom extension attributes (computed cost, retry marking)."""

    COST_INPUT_USD: Final = "tracebloom.cost.input_usd"
    COST_OUTPUT_USD: Final = "tracebloom.cost.output_usd"
    COST_TOTAL_USD: Final = "tracebloom.cost.total_usd"
    #: 1-based attempt number for an operation that may be retried. Absent or 1
    #: means "first try"; >= 2 marks the span as a retry (the trace viewer
    #: highlights these). There is no gen_ai.* retry convention yet, hence the
    #: tracebloom.* extension key.
    RETRY_ATTEMPT: Final = "tracebloom.retry.attempt"


#: Event name for a model response choice.
EVENT_CHOICE: Final = "gen_ai.choice"


def message_event_name(role: str) -> str:
    """Event name for an input message of the given role (user/system/assistant/tool)."""
    return f"gen_ai.{role}.message"
