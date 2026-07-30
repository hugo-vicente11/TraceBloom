"""The TraceBloom enrichment stage: one span processor that adapts whatever the
OTel GenAI instrumentations emit to TraceBloom's storage contract.

On start it stamps the active prompt tag (variant) onto every new span. On end
it (a) normalizes legacy ``gen_ai`` attribute keys to the latest convention the
collector promotes, (b) computes ``tracebloom.cost.*`` from usage tokens and
the shared pricing map, and (c) enforces the content rule (DECISIONS.md D2):
prompt/response content is **never** allowed to remain a span attribute — when
content capture is on, content-bearing attributes (``gen_ai.input.messages`` /
``gen_ai.output.messages`` from the latest conventions, or the legacy indexed
``gen_ai.prompt.N.*`` / ``gen_ai.completion.N.*`` shape) are converted into
``gen_ai.{role}.message`` / ``gen_ai.choice`` span events (the shape the TS SDK
emits and the eval runner reconstructs); when capture is off they are simply
dropped. Instrumentation is *not trusted* to get this right — the rule is
enforced here, at the edge, for every exported span.

The on-end mutation touches ``ReadableSpan``'s private ``_attributes`` /
``_events`` fields (the OTel SDK offers no sanctioned rewrite hook);
``tests/test_enrichment.py`` pins this against the locked OTel version.
"""

from __future__ import annotations

import json
import re
from typing import Any

from opentelemetry.context import Context
from opentelemetry.sdk.trace import Event, ReadableSpan, Span, SpanProcessor

from ._openinference import normalize_openinference
from .attributes import EVENT_CHOICE, GenAIAttr, TraceBloomAttr, message_event_name
from .pricing import PricingMap, compute_cost
from .prompt import active_prompt_tag

#: Older instrumentations emit pre-rename keys; the collector promotes the new ones.
_LEGACY_KEY_RENAMES = {
    "gen_ai.usage.prompt_tokens": GenAIAttr.USAGE_INPUT_TOKENS,
    "gen_ai.usage.completion_tokens": GenAIAttr.USAGE_OUTPUT_TOKENS,
    "gen_ai.system": GenAIAttr.PROVIDER_NAME,
}

_INPUT_MESSAGES_ATTR = "gen_ai.input.messages"
_OUTPUT_MESSAGES_ATTR = "gen_ai.output.messages"
_SYSTEM_INSTRUCTIONS_ATTR = "gen_ai.system_instructions"
_INDEXED_CONTENT_RE = re.compile(
    r"^gen_ai\.(prompt|completion)\.(\d+)\.(role|content|finish_reason)$"
)

#: Framework step payloads (LangChain/LangGraph chain + graph-node spans emit
#: the run state as gen_ai.task.* / traceloop.entity.*): dropped
#: unconditionally rather than converted to events, they duplicate the whole
#: conversation on every node, and the chat spans already carry it as events.
_DROPPED_CONTENT_ATTRS = (
    "gen_ai.task.input",
    "gen_ai.task.output",
    "traceloop.entity.input",
    "traceloop.entity.output",
)
#: Tool-execution content (spec opt-in attributes; emitted by the LangChain
#: instrumentation). Real content, so it follows the D2 rule: converted to
#: span events when capture is on, dropped otherwise.
_TOOL_ARGUMENTS_ATTR = "gen_ai.tool.call.arguments"
_TOOL_RESULT_ATTR = "gen_ai.tool.call.result"
#: Traceloop vendor attributes (association properties, span kinds, entity
#: metadata): redundant with the gen_ai.* keys the same spans carry.
_TRACELOOP_PREFIX = "traceloop."
#: The LangChain instrumentation re-derives the request model from the
#: model's *serialized* constructor kwargs, which downgrades custom/wrapped
#: (non-serializable) chat models to the literal "unknown", while the
#: langsmith ``ls_model_name`` metadata rides along as an association
#: property. Promote that hint so cost still computes for such models.
_LS_MODEL_NAME_ATTR = "traceloop.association.properties.ls_model_name"

#: Prompt/response content event names (input roles + output choice).
_CONTENT_EVENT_RE = re.compile(r"^gen_ai\.(\w+\.message|choice)$")


def _part_text(part: Any) -> str:
    """Best-effort text of one message part from the latest-conventions shape."""
    if isinstance(part, str):
        return part
    if isinstance(part, dict):
        for key in ("content", "text"):
            value = part.get(key)
            if isinstance(value, str):
                return value
    return json.dumps(part, separators=(",", ":"))


def _message_text(message: dict[str, Any]) -> str:
    parts = message.get("parts")
    if isinstance(parts, list):
        return "\n".join(_part_text(part) for part in parts)
    content = message.get("content")
    if isinstance(content, str):
        return content
    if content is not None:
        return json.dumps(content, separators=(",", ":"))
    return ""


def _parse_messages(value: object) -> list[dict[str, Any]]:
    """Decode a messages attribute: a JSON string (how the conventions serialize
    structured attributes) or an already-structured sequence. Unparseable input
    yields [] — enrichment must never throw on the export path."""
    if isinstance(value, (str, bytes)):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    if not isinstance(value, (list, tuple)):
        return []
    return [m for m in value if isinstance(m, dict)]


def _collect_content(
    attrs: dict[str, Any],
) -> tuple[list[tuple[str, str]], list[tuple[int, str, str]]]:
    """Pop every content-bearing attribute and return (input messages as
    (role, content), output choices as (index, finish_reason, content))."""
    inputs: list[tuple[str, str]] = []
    choices: list[tuple[int, str, str]] = []

    system = attrs.pop(_SYSTEM_INSTRUCTIONS_ATTR, None)
    if system is not None:
        for message in _parse_messages(system):
            inputs.append(("system", _message_text(message)))
        if isinstance(system, str) and not _parse_messages(system):
            inputs.append(("system", system))

    for message in _parse_messages(attrs.pop(_INPUT_MESSAGES_ATTR, None)):
        role = message.get("role")
        inputs.append((role if isinstance(role, str) else "user", _message_text(message)))

    for index, message in enumerate(_parse_messages(attrs.pop(_OUTPUT_MESSAGES_ATTR, None))):
        finish = message.get("finish_reason")
        choices.append((index, finish if isinstance(finish, str) else "", _message_text(message)))

    # Legacy indexed shape: gen_ai.prompt.0.role / .content, gen_ai.completion.0.*.
    indexed: dict[tuple[str, int], dict[str, str]] = {}
    for key in [k for k in attrs if _INDEXED_CONTENT_RE.match(k)]:
        match = _INDEXED_CONTENT_RE.match(key)
        assert match is not None
        group = indexed.setdefault((match.group(1), int(match.group(2))), {})
        group[match.group(3)] = str(attrs.pop(key))
    for (kind, index), fields in sorted(indexed.items()):
        content = fields.get("content", "")
        if kind == "prompt":
            inputs.append((fields.get("role", "user"), content))
        else:
            choices.append((index, fields.get("finish_reason", ""), content))

    # Tool-execution content: arguments render as a tool-role input message,
    # the result as the span's output choice.
    arguments = attrs.pop(_TOOL_ARGUMENTS_ATTR, None)
    if arguments is not None:
        inputs.append(("tool", arguments if isinstance(arguments, str) else str(arguments)))
    result = attrs.pop(_TOOL_RESULT_ATTR, None)
    if result is not None:
        choices.append((0, "", result if isinstance(result, str) else str(result)))

    return inputs, choices


def enrich_readable_span(span: ReadableSpan, pricing: PricingMap, capture_content: bool) -> None:
    """Normalize + enrich one ended span in place (see module docstring)."""
    attrs: dict[str, Any] = dict(span.attributes or {})

    # OpenInference-emitting integrations (LlamaIndex, OpenAI Agents SDK)
    # rewrite to gen_ai first, so the cost/content stages below see the same
    # canonical keys every other instrumentation produces.
    openinference = normalize_openinference(span.name, attrs)

    for legacy, canonical in _LEGACY_KEY_RENAMES.items():
        if legacy in attrs:
            value = attrs.pop(legacy)
            attrs.setdefault(canonical, value)

    for key in _DROPPED_CONTENT_ATTRS:
        attrs.pop(key, None)

    inputs, choices = _collect_content(attrs)
    if openinference is not None:
        inputs = openinference.inputs + inputs
        choices = openinference.choices + choices

    model_hint = attrs.get(_LS_MODEL_NAME_ATTR)
    if isinstance(model_hint, str) and model_hint:
        for key in (GenAIAttr.REQUEST_MODEL, GenAIAttr.RESPONSE_MODEL):
            if attrs.get(key) in (None, "", "unknown"):
                attrs[key] = model_hint

    for key in [k for k in attrs if k.startswith(_TRACELOOP_PREFIX)]:
        del attrs[key]

    if TraceBloomAttr.COST_TOTAL_USD not in attrs:
        model = attrs.get(GenAIAttr.RESPONSE_MODEL) or attrs.get(GenAIAttr.REQUEST_MODEL)
        input_tokens = attrs.get(GenAIAttr.USAGE_INPUT_TOKENS)
        output_tokens = attrs.get(GenAIAttr.USAGE_OUTPUT_TOKENS)
        has_usage = isinstance(input_tokens, int) or isinstance(output_tokens, int)
        if isinstance(model, str) and model and has_usage:
            cost = compute_cost(
                model,
                input_tokens if isinstance(input_tokens, int) else 0,
                output_tokens if isinstance(output_tokens, int) else 0,
                pricing,
            )
            attrs[TraceBloomAttr.COST_INPUT_USD] = cost.input_usd
            attrs[TraceBloomAttr.COST_OUTPUT_USD] = cost.output_usd
            attrs[TraceBloomAttr.COST_TOTAL_USD] = cost.total_usd

    span._attributes = attrs  # noqa: SLF001 — see module docstring
    if openinference is not None and openinference.span_name:
        # Canonical names ("chat gpt-4o", "execute_tool web_search") so all
        # frameworks read identically in the viewer.
        span._name = openinference.span_name  # noqa: SLF001 — see module docstring

    if capture_content and (inputs or choices):
        existing = list(span.events)
        # If content events are already present (e.g. emitted in-span by a
        # future instrumentation), don't duplicate them from attributes.
        if not any(_CONTENT_EVENT_RE.match(event.name) for event in existing):
            start = span.start_time or 0
            end = span.end_time or start
            events = existing + [
                Event(message_event_name(role), {"content": content}, timestamp=start)
                for role, content in inputs
            ]
            events += [
                Event(
                    EVENT_CHOICE,
                    {"index": index, "finish_reason": finish, "content": content},
                    timestamp=end,
                )
                for index, finish, content in choices
            ]
            span._events = events  # noqa: SLF001 — see module docstring


class TraceBloomSpanProcessor(SpanProcessor):
    """Variant stamping at span start + enrichment at span end.

    Must be registered *before* the exporting processor so spans are already
    enriched when they are handed to the exporter (processors run in
    registration order).
    """

    def __init__(self, pricing: PricingMap, capture_content: bool) -> None:
        self._pricing = pricing
        self._capture_content = capture_content

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        tag = active_prompt_tag()
        if tag is None or not span.is_recording():
            return
        existing = span.attributes or {}
        if GenAIAttr.PROMPT_VERSION not in existing:
            span.set_attribute(GenAIAttr.PROMPT_VERSION, tag.version)
            if tag.name is not None and GenAIAttr.PROMPT_NAME not in existing:
                span.set_attribute(GenAIAttr.PROMPT_NAME, tag.name)

    def on_end(self, span: ReadableSpan) -> None:
        enrich_readable_span(span, self._pricing, self._capture_content)

    def shutdown(self) -> None:  # noqa: D102 — nothing to release
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:  # noqa: D102
        return True
