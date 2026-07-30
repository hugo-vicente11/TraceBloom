"""Cross-framework consistency.

The M7 promise is that framework-captured spans behave *identically* to the
manual / auto-instrumented paths, and coherently with each other. This suite
runs every Python framework integration through one set of assertions so the
guarantees are checked in one place rather than trusted per integration:

- every span uses the canonical gen_ai operation vocabulary (so a LangGraph
  run and a LlamaIndex run categorize the same way in the M3 viewer);
- no vendor- or content-namespaced key survives export with capture off;
- cost on model spans comes from the shared pricing map, byte-for-byte the
  same arithmetic as the OpenAI/Anthropic paths;
- the `prompt_version` variant tag lands on every span of the run;
- the `record_evaluation` eval hook attaches to a wrapping `agent_span`, with
  the whole framework run nested underneath it in one trace.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

import tracebloom
from tests.conftest import SdkFactory
from tests.test_langgraph import MODEL as LANGGRAPH_MODEL
from tests.test_langgraph import run_graph
from tests.test_llamaindex import MODEL as LLAMAINDEX_MODEL
from tests.test_llamaindex import run_agent as run_llamaindex
from tests.test_openai_agents import MODEL as AGENTS_MODEL
from tests.test_openai_agents import run_agent as run_openai_agents

#: The complete gen_ai operation vocabulary every integration is allowed to
#: emit: the union of what the M3 viewer categorizes plus the step/tool ops.
CANONICAL_OPERATIONS = {
    "invoke_agent",
    "create_agent",
    "execute_task",
    "execute_tool",
    "chat",
    "text_completion",
    "generate_content",
    "embeddings",
}

#: Namespaces that must never survive enrichment (vendor keys + raw content).
FORBIDDEN_PREFIXES = (
    "traceloop.",
    "openinference.",
    "llm.",
    "input.",
    "output.",
    "tool.",
    "retrieval.",
    "embedding.",
    "gen_ai.task.input",
    "gen_ai.task.output",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
)

#: (instrument name, run function, model the run reports) per framework.
FRAMEWORKS: list[tuple[str, Callable[[], None], str]] = [
    ("langgraph", run_graph, LANGGRAPH_MODEL),
    ("llama_index", run_llamaindex, LLAMAINDEX_MODEL),
    ("openai_agents", run_openai_agents, AGENTS_MODEL),
]
FRAMEWORK_IDS = [name for name, _, _ in FRAMEWORKS]


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_only_canonical_operations(
    sdk: SdkFactory, instrument: str, run: Callable[[], None], model: str
) -> None:
    exporter = sdk(instrument=[instrument])
    run()
    spans = exporter.get_finished_spans()
    assert spans
    for span in spans:
        attrs = span.attributes or {}
        operation = attrs.get("gen_ai.operation.name")
        assert operation in CANONICAL_OPERATIONS, f"{span.name}: non-canonical op {operation!r}"


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_no_vendor_or_content_keys_by_default(
    sdk: SdkFactory, instrument: str, run: Callable[[], None], model: str
) -> None:
    exporter = sdk(instrument=[instrument])
    run()
    for span in exporter.get_finished_spans():
        for key in span.attributes or {}:
            assert not key.startswith(FORBIDDEN_PREFIXES), f"{span.name}: leaked {key}"
        content_events = [e for e in span.events if "message" in e.name or "choice" in e.name]
        assert content_events == [], f"{span.name}: content events with capture off"


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_model_span_cost_from_shared_pricing(
    sdk: SdkFactory, instrument: str, run: Callable[[], None], model: str
) -> None:
    exporter = sdk(instrument=[instrument])
    run()
    chats = [
        s
        for s in exporter.get_finished_spans()
        if (s.attributes or {}).get("gen_ai.operation.name") == "chat"
    ]
    assert chats, f"{instrument}: no chat spans"
    for chat in chats:
        attrs = chat.attributes or {}
        input_tokens = attrs.get("gen_ai.usage.input_tokens")
        output_tokens = attrs.get("gen_ai.usage.output_tokens")
        assert isinstance(input_tokens, int) and isinstance(output_tokens, int)
        expected = tracebloom.compute_cost(model, input_tokens, output_tokens)
        assert attrs["tracebloom.cost.input_usd"] == expected.input_usd
        assert attrs["tracebloom.cost.output_usd"] == expected.output_usd
        assert attrs["tracebloom.cost.total_usd"] == expected.total_usd


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_variant_tag_on_every_span(
    sdk: SdkFactory, instrument: str, run: Callable[[], None], model: str
) -> None:
    exporter = sdk(instrument=[instrument])
    with tracebloom.prompt_version("v2", "research"):
        run()
    spans = exporter.get_finished_spans()
    assert spans
    for span in spans:
        attrs = span.attributes or {}
        assert attrs.get("gen_ai.prompt.version") == "v2", span.name


@pytest.mark.parametrize(("instrument", "run", "model"), FRAMEWORKS, ids=FRAMEWORK_IDS)
def test_eval_hook_attaches_to_wrapping_agent_span(
    sdk: SdkFactory, instrument: str, run: Callable[[], None], model: str
) -> None:
    exporter = sdk(instrument=[instrument])
    with tracebloom.agent_span("wrapper"):
        tracebloom.record_evaluation("run_quality", score=0.7, label="pass")
        run()
    spans = exporter.get_finished_spans()

    (wrapper,) = [s for s in spans if s.name == "invoke_agent wrapper"]
    eval_events = [e for e in wrapper.events if e.name == "gen_ai.evaluation.result"]
    assert eval_events, "eval event missing from the wrapping span"
    assert eval_events[0].attributes is not None
    assert eval_events[0].attributes["gen_ai.evaluation.name"] == "run_quality"
    assert eval_events[0].attributes["gen_ai.evaluation.score.value"] == 0.7

    # The framework run nested under the wrapper: one trace, wrapper is a root.
    assert wrapper.parent is None
    assert len({s.context.trace_id for s in spans}) == 1
    assert len(spans) > 1, "framework spans did not nest under the wrapper"
