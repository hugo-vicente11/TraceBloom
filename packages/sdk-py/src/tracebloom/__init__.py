"""TraceBloom Python SDK.

Emits OpenTelemetry ``gen_ai`` spans for LLM and agent operations to the
TraceBloom collector. Public API mirrors the TypeScript SDK
(``packages/sdk-ts``) — same names (snake_cased), same semantics.

Quickstart::

    import tracebloom

    tracebloom.init(endpoint="http://localhost:4318", service_name="my-app")
    # installed OpenAI / Anthropic clients are now auto-instrumented

    with tracebloom.agent_span("researcher"):
        with tracebloom.tool_span("web.search"):
            ...
"""

from __future__ import annotations

from .agent import AttributeValue, agent_span, tool_span
from .attributes import EVENT_CHOICE, GenAIAttr, TraceBloomAttr, message_event_name
from .evals import EVALUATION_RESULT_EVENT, EvaluationAttr, record_evaluation
from .pricing import (
    DEFAULT_PRICING,
    CostBreakdown,
    ModelPrice,
    PricingMap,
    compute_cost,
    lookup_price,
)
from .prompt import PromptTag, prompt_version, set_prompt_version
from .tracer import RuntimeState, get_state, init, shutdown

__all__ = [
    "DEFAULT_PRICING",
    "EVALUATION_RESULT_EVENT",
    "EVENT_CHOICE",
    "AttributeValue",
    "CostBreakdown",
    "EvaluationAttr",
    "GenAIAttr",
    "ModelPrice",
    "PricingMap",
    "PromptTag",
    "RuntimeState",
    "TraceBloomAttr",
    "__version__",
    "agent_span",
    "compute_cost",
    "get_state",
    "init",
    "lookup_price",
    "message_event_name",
    "prompt_version",
    "record_evaluation",
    "set_prompt_version",
    "shutdown",
    "tool_span",
]
__version__ = "0.1.0"
