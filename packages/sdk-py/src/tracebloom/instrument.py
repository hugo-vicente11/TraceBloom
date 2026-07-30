"""One-line auto-instrumentation.

``init()`` applies the instrumentation for every requested provider library or
agent framework that is actually importable, wired to TraceBloom's tracer
provider — so existing OpenAI / Anthropic calls (and, opted in, whole
LangGraph / LlamaIndex / OpenAI-Agents runs) emit ``gen_ai`` spans with no
further code changes. Missing libraries (or missing instrumentation packages)
are a silent no-op, and an instrumentation that fails to apply logs a warning
and is skipped: auto-instrumentation must never crash the host app.

Every instrumentation is an existing OpenTelemetry-ecosystem package built on
the framework's native hook (OTel GenAI / Traceloop callback handlers,
LlamaIndex's instrumentation dispatcher, the OpenAI Agents SDK's trace
processors) rather than hand-rolled patching — TraceBloom only adapts their
output at the edge (see ``_processor.py``).
"""

from __future__ import annotations

import importlib.util
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from opentelemetry.sdk.trace import TracerProvider

logger = logging.getLogger("tracebloom")

#: Instrumented by default when the library is installed. Agent frameworks
#: (langchain/langgraph/llama_index/openai_agents) are opt-in, pass
#: ``instrument=["openai", ..., "langgraph"]``: because they capture a whole
#: framework rather than one client library (DECISIONS.md D19).
DEFAULT_INSTRUMENTATIONS: tuple[str, ...] = ("openai", "anthropic")


class _Instrumentor(Protocol):
    """The BaseInstrumentor surface we rely on."""

    @property
    def is_instrumented_by_opentelemetry(self) -> bool: ...

    def instrument(self, **kwargs: object) -> object: ...

    def uninstrument(self, **kwargs: object) -> object: ...


def _load_openai() -> _Instrumentor:
    from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor

    return OpenAIInstrumentor()  # type: ignore[no-untyped-call]


def _load_anthropic() -> _Instrumentor:
    from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor

    return AnthropicInstrumentor()


def _load_langchain() -> _Instrumentor:
    from opentelemetry.instrumentation.langchain import LangchainInstrumentor

    return LangchainInstrumentor()


def _load_llama_index() -> _Instrumentor:
    from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

    return LlamaIndexInstrumentor()


def _load_openai_agents() -> _Instrumentor:
    from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor

    return OpenAIAgentsInstrumentor()


def _cleanup_langchain() -> None:
    """Fix up after the Traceloop langchain instrumentation's broken undo.

    Its ``_uninstrument`` passes ``"Class.method"`` attribute paths to OTel's
    ``unwrap()``, whose plain ``getattr`` can't resolve them — a silent no-op
    that leaves every wrapt wrapper in place. The stale callback handler stays
    bound to the torn-down tracer provider AND blocks the handler of a later
    ``init()`` from registering (the injection wrapper dedupes handlers by
    type), so init/shutdown cycles (tests, notebooks) lose all framework
    spans. Strip the leftover wrappers of every site 0.62.x wraps; against a
    fixed upstream release this finds no proxies and does nothing.
    """
    import sys

    import wrapt

    proxy_type: type = getattr(wrapt, "BaseObjectProxy", wrapt.ObjectProxy)

    sites: list[tuple[str, str | None, str]] = [
        ("langchain_core.callbacks", "BaseCallbackManager", "__init__"),
        ("langgraph.pregel", "Pregel", "stream"),
        ("langgraph.pregel", "Pregel", "astream"),
        ("langgraph.types", "Command", "__init__"),
        ("langgraph.prebuilt.chat_agent_executor", None, "create_react_agent"),
        ("langgraph.prebuilt", None, "create_react_agent"),
        ("langchain.agents.factory", None, "create_agent"),
        ("langchain.agents", None, "create_agent"),
    ]
    for hook in (
        "before_model",
        "after_model",
        "before_agent",
        "after_agent",
        "abefore_model",
        "aafter_model",
        "abefore_agent",
        "aafter_agent",
    ):
        sites.append(("langchain.agents.middleware.types", "AgentMiddleware", hook))
    for method in ("_generate", "_agenerate", "_stream", "_astream"):
        sites.append(("langchain_community.llms.openai", "BaseOpenAI", method))
        sites.append(("langchain_openai.llms.base", "BaseOpenAI", method))
    for method in ("_generate", "_agenerate"):
        sites.append(("langchain_openai.chat_models.base", "BaseChatOpenAI", method))

    for module_name, class_name, attr in sites:
        module = sys.modules.get(module_name)
        if module is None:
            continue
        owner: object = module if class_name is None else getattr(module, class_name, None)
        if owner is None:
            continue
        func = getattr(owner, attr, None)
        while isinstance(func, proxy_type) and hasattr(func, "__wrapped__"):
            setattr(owner, attr, func.__wrapped__)
            func = getattr(owner, attr, None)


@dataclass(frozen=True)
class _Entry:
    """One instrumentable target."""

    #: Module whose importability gates the instrumentation (the user's
    #: library, not the instrumentation package).
    library_module: str
    #: ``tracebloom[<extra>]`` that installs the instrumentation package.
    extra: str
    loader: Callable[[], _Instrumentor]
    #: Extra kwargs passed to ``instrument()`` alongside ``tracer_provider``.
    instrument_kwargs: dict[str, object] | None = None
    #: Corrective cleanup run after ``uninstrument()`` (upstream undo bugs).
    cleanup: Callable[[], None] | None = None


#: instrument= name -> how to apply it. LangGraph executes through
#: langchain-core callbacks, so both names gate on their own library but share
#: one instrumentor (applying it twice is a no-op).
_REGISTRY: dict[str, _Entry] = {
    "openai": _Entry("openai", "openai", _load_openai),
    "anthropic": _Entry("anthropic", "anthropic", _load_anthropic),
    "langchain": _Entry("langchain_core", "langchain", _load_langchain, cleanup=_cleanup_langchain),
    "langgraph": _Entry("langgraph", "langgraph", _load_langchain, cleanup=_cleanup_langchain),
    "llama_index": _Entry("llama_index.core", "llamaindex", _load_llama_index),
    "openai_agents": _Entry("agents", "openai-agents", _load_openai_agents),
}

#: (instrumentor, cleanup) applied by the current init(), so shutdown() can
#: undo them.
_active: list[tuple[_Instrumentor, Callable[[], None] | None]] = []


def apply_instrumentations(
    names: Sequence[str], tracer_provider: TracerProvider
) -> tuple[str, ...]:
    """Apply the named instrumentations; returns the ones actually applied."""
    applied: list[str] = []
    for name in names:
        entry = _REGISTRY.get(name)
        if entry is None:
            logger.warning(
                "tracebloom: unknown instrumentation %r (known: %s)",
                name,
                ", ".join(sorted(_REGISTRY)),
            )
            continue
        try:
            if importlib.util.find_spec(entry.library_module) is None:
                # The library isn't installed: silent no-op.
                continue
        except (ImportError, ValueError):
            continue
        try:
            instrumentor = entry.loader()
        except ImportError:
            # Library present but its instrumentation package isn't installed.
            logger.debug(
                "tracebloom: %s is installed but its instrumentation package "
                "is not; skipping (pip install 'tracebloom[%s]')",
                name,
                entry.extra,
            )
            continue
        try:
            if not instrumentor.is_instrumented_by_opentelemetry:
                instrumentor.instrument(
                    tracer_provider=tracer_provider, **(entry.instrument_kwargs or {})
                )
                _active.append((instrumentor, entry.cleanup))
            applied.append(name)
        except Exception:  # noqa: BLE001 — never crash the host app
            logger.warning("tracebloom: failed to instrument %s; skipping", name, exc_info=True)
    return tuple(applied)


def remove_instrumentations() -> None:
    """Best-effort undo of everything applied (called from shutdown())."""
    while _active:
        instrumentor, cleanup = _active.pop()
        try:
            if instrumentor.is_instrumented_by_opentelemetry:
                instrumentor.uninstrument()
            if cleanup is not None:
                cleanup()
        except Exception:  # noqa: BLE001 — shutdown must not raise
            logger.debug("tracebloom: uninstrument failed", exc_info=True)
