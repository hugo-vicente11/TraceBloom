"""OpenInference → OpenTelemetry GenAI mapping.

The LlamaIndex and OpenAI-Agents integrations reuse Arize's OpenInference
instrumentors (built on each framework's native hook), which emit the
OpenInference semantic conventions — ``openinference.span.kind``,
``llm.token_count.*``, indexed ``llm.input_messages.N.*`` — rather than
``gen_ai.*``. This module rewrites one span's attributes in place to the
canonical shape everything else in TraceBloom emits, so a LlamaIndex run and a
LangGraph run look identical in the viewer, cost computes from the shared
pricing map, and the D2 content rule holds:

==================  =====================================================
OpenInference kind  gen_ai mapping
==================  =====================================================
LLM                 ``chat`` (model, usage tokens, request params)
TOOL                ``execute_tool`` (tool name/description)
AGENT               ``invoke_agent``
CHAIN               ``execute_task`` — except workflow-agent roots named
                    ``<X>Agent.run`` / ``AgentWorkflow.run``, which are
                    ``invoke_agent`` (the modern LlamaIndex agents are
                    workflows; upstream only tags the legacy BaseAgent
                    classes as AGENT)
RETRIEVER           ``execute_task`` (retrieved documents become the
                    span's output content)
EMBEDDING           ``embeddings``
==================  =====================================================

Content-bearing attributes (``input.value`` / ``output.value``, the indexed
message lists, retrieved documents, embedding texts) are always popped —
LLM messages, tool input/output and retrieved documents are returned to the
caller so the enrichment stage can turn them into D2 span events when capture
is on; chain/agent step payloads are dropped outright (they duplicate the
conversation that already rides the LLM spans). Every remaining
OpenInference-namespaced key is stripped before export.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .attributes import GenAIAttr

SPAN_KIND_ATTR = "openinference.span.kind"

_INPUT_VALUE = "input.value"
_OUTPUT_VALUE = "output.value"
_MODEL_NAME = "llm.model_name"
_PROVIDER = "llm.provider"
_SYSTEM = "llm.system"
_TOKEN_PROMPT = "llm.token_count.prompt"
_TOKEN_COMPLETION = "llm.token_count.completion"
_INVOCATION_PARAMETERS = "llm.invocation_parameters"
_TOOL_NAME = "tool.name"
_TOOL_DESCRIPTION = "tool.description"
_GRAPH_NODE_ID = "graph.node.id"
_EMBEDDING_MODEL = "embedding.model_name"

_INPUT_MESSAGE_RE = re.compile(r"^llm\.input_messages\.(\d+)\.message\.(role|content)$")
_OUTPUT_MESSAGE_RE = re.compile(r"^llm\.output_messages\.(\d+)\.message\.(role|content)$")
_DOCUMENT_CONTENT_RE = re.compile(r"^retrieval\.documents\.(\d+)\.document\.content$")

#: Modern LlamaIndex agents are workflows; their run root is a CHAIN span
#: named after the agent class. (Upstream only assigns AGENT to the legacy
#: BaseAgent/BaseAgentWorker classes.)
_WORKFLOW_AGENT_RUN_RE = re.compile(r"^(\w*Agent\w*)\.run$")

#: Everything OpenInference-namespaced is stripped after mapping; the canonical
#: keys carry what TraceBloom stores.
_STRIP_PREFIXES = (
    "openinference.",
    "llm.",
    "input.",
    "output.",
    "tool.",
    "retrieval.",
    "embedding.",
    "message.",
    "graph.",
    "session.",
    "user.",
    "tag.",
    "metadata",
)

#: Request parameters worth promoting from llm.invocation_parameters JSON.
_PARAM_KEYS = {
    "temperature": GenAIAttr.REQUEST_TEMPERATURE,
    "top_p": GenAIAttr.REQUEST_TOP_P,
    "max_tokens": GenAIAttr.REQUEST_MAX_TOKENS,
}


@dataclass
class OpenInferenceContent:
    """Content captured off an OpenInference span, plus its canonical name."""

    span_name: str | None = None
    #: (role, content) input messages.
    inputs: list[tuple[str, str]] = field(default_factory=list)
    #: (index, finish_reason, content) output choices.
    choices: list[tuple[int, str, str]] = field(default_factory=list)


def _collect_indexed(attrs: dict[str, Any], pattern: re.Pattern[str]) -> dict[int, dict[str, str]]:
    """Pop ``<prefix>.N.<field>`` attributes into {index: {field: value}}."""
    collected: dict[int, dict[str, str]] = {}
    for key in [k for k in attrs if pattern.match(k)]:
        match = pattern.match(key)
        assert match is not None
        index = int(match.group(1))
        fields = collected.setdefault(index, {})
        name = match.group(2) if match.re.groups > 1 else "content"
        fields[name] = str(attrs.pop(key))
    return collected


def _promote_llm_attrs(attrs: dict[str, Any]) -> None:
    """Model, usage tokens, provider and request params → canonical keys."""
    model = attrs.pop(_MODEL_NAME, None)
    if isinstance(model, str) and model:
        attrs.setdefault(GenAIAttr.REQUEST_MODEL, model)
        attrs.setdefault(GenAIAttr.RESPONSE_MODEL, model)
    provider = attrs.pop(_PROVIDER, None) or attrs.get(_SYSTEM)
    if isinstance(provider, str) and provider:
        attrs.setdefault(GenAIAttr.PROVIDER_NAME, provider)
    prompt_tokens = attrs.pop(_TOKEN_PROMPT, None)
    if isinstance(prompt_tokens, int):
        attrs.setdefault(GenAIAttr.USAGE_INPUT_TOKENS, prompt_tokens)
    completion_tokens = attrs.pop(_TOKEN_COMPLETION, None)
    if isinstance(completion_tokens, int):
        attrs.setdefault(GenAIAttr.USAGE_OUTPUT_TOKENS, completion_tokens)
    params_json = attrs.pop(_INVOCATION_PARAMETERS, None)
    if isinstance(params_json, str):
        try:
            params = json.loads(params_json)
        except ValueError:
            params = None
        if isinstance(params, dict):
            for source, target in _PARAM_KEYS.items():
                value = params.get(source)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    attrs.setdefault(target, value)


def normalize_openinference(name: str, attrs: dict[str, Any]) -> OpenInferenceContent | None:
    """Rewrite one OpenInference span's attributes to gen_ai in place.

    Returns the captured content (for D2 event conversion) and the canonical
    span name, or ``None`` when the span is not an OpenInference span. The
    caller owns writing events and renaming.
    """
    kind = attrs.pop(SPAN_KIND_ATTR, None)
    if not isinstance(kind, str):
        return None

    result = OpenInferenceContent()
    input_value = attrs.pop(_INPUT_VALUE, None)
    output_value = attrs.pop(_OUTPUT_VALUE, None)
    input_messages = _collect_indexed(attrs, _INPUT_MESSAGE_RE)
    output_messages = _collect_indexed(attrs, _OUTPUT_MESSAGE_RE)
    documents = _collect_indexed(attrs, _DOCUMENT_CONTENT_RE)

    if kind == "LLM":
        attrs[GenAIAttr.OPERATION_NAME] = "chat"
        _promote_llm_attrs(attrs)
        model = attrs.get(GenAIAttr.REQUEST_MODEL)
        result.span_name = f"chat {model}" if isinstance(model, str) and model else "chat"
        for _, fields in sorted(input_messages.items()):
            result.inputs.append((fields.get("role", "user"), fields.get("content", "")))
        for index, fields in sorted(output_messages.items()):
            result.choices.append((index, "", fields.get("content", "")))
    elif kind == "TOOL":
        attrs[GenAIAttr.OPERATION_NAME] = "execute_tool"
        tool_name = attrs.pop(_TOOL_NAME, None)
        if isinstance(tool_name, str) and tool_name:
            attrs.setdefault(GenAIAttr.TOOL_NAME, tool_name)
        else:
            tool_name = name
        description = attrs.pop(_TOOL_DESCRIPTION, None)
        if isinstance(description, str) and description:
            attrs.setdefault(GenAIAttr.TOOL_DESCRIPTION, description)
        result.span_name = f"execute_tool {attrs.get(GenAIAttr.TOOL_NAME, tool_name)}"
        if input_value is not None:
            result.inputs.append(("tool", str(input_value)))
        if output_value is not None:
            result.choices.append((0, "", str(output_value)))
    elif kind == "AGENT" or (kind == "CHAIN" and _WORKFLOW_AGENT_RUN_RE.match(name)):
        attrs[GenAIAttr.OPERATION_NAME] = "invoke_agent"
        match = _WORKFLOW_AGENT_RUN_RE.match(name)
        agent_name = match.group(1) if match else name
        attrs.setdefault(GenAIAttr.AGENT_NAME, agent_name)
        node_id = attrs.pop(_GRAPH_NODE_ID, None)
        if isinstance(node_id, str) and node_id:
            attrs.setdefault(GenAIAttr.AGENT_ID, node_id)
        result.span_name = f"invoke_agent {agent_name}"
    elif kind == "RETRIEVER":
        attrs[GenAIAttr.OPERATION_NAME] = "execute_task"
        attrs.setdefault("gen_ai.task.name", name)
        result.span_name = f"execute_task {name}"
        for index, fields in sorted(documents.items()):
            result.choices.append((index, "", fields.get("content", "")))
    elif kind == "EMBEDDING":
        attrs[GenAIAttr.OPERATION_NAME] = "embeddings"
        model = attrs.pop(_EMBEDDING_MODEL, None)
        if isinstance(model, str) and model:
            attrs.setdefault(GenAIAttr.REQUEST_MODEL, model)
        result.span_name = f"embeddings {model}" if isinstance(model, str) and model else name
    else:
        # CHAIN and anything unrecognized: a framework step.
        attrs[GenAIAttr.OPERATION_NAME] = "execute_task"
        attrs.setdefault("gen_ai.task.name", name)
        result.span_name = f"execute_task {name}"

    for key in [k for k in attrs if k.startswith(_STRIP_PREFIXES)]:
        del attrs[key]
    return result
