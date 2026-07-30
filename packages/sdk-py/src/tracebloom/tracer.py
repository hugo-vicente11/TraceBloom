"""SDK initialization: wires an OpenTelemetry tracer provider with an OTLP/HTTP
(protobuf) exporter pointed at the TraceBloom collector. :func:`init` is the one
documented setup call; everything else (auto-instrumentation, manual spans) uses
the state it establishes. Mirrors ``packages/sdk-ts/src/tracer.ts``.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Tracer

from ._processor import TraceBloomSpanProcessor
from .instrument import DEFAULT_INSTRUMENTATIONS, apply_instrumentations, remove_instrumentations
from .pricing import DEFAULT_PRICING, PricingMap

_TRACER_NAME = "tracebloom-sdk"
_TRACER_VERSION = "0.1.0"
_DEFAULT_ENDPOINT = "http://localhost:4318"

#: The GenAI semantic conventions are experimental; instrumentation packages
#: only emit the latest gen_ai.* shape (the one the collector promotes) when
#: this opt-in is present. init() adds it to the environment if missing.
_SEMCONV_OPT_IN_ENV = "OTEL_SEMCONV_STABILITY_OPT_IN"
_SEMCONV_OPT_IN_VALUE = "gen_ai_latest_experimental"

#: Content-capture mode read by the OTel GenAI instrumentations. TraceBloom
#: needs content on the *trace* pipeline (span attributes it can convert to
#: span events); `event_only` would route content to a Logs pipeline the
#: collector doesn't ingest.
_CAPTURE_CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
_CAPTURE_CONTENT_MODE = "span_only"


@dataclass
class RuntimeState:
    """The active SDK runtime, created by :func:`init`."""

    tracer: Tracer
    pricing: PricingMap
    capture_content: bool
    #: Auto-instrumentations actually applied (libraries that were installed).
    instrumented: tuple[str, ...] = ()


_provider: TracerProvider | None = None
_state: RuntimeState | None = None


def _env_capture_content() -> bool:
    return os.environ.get("TRACEBLOOM_CAPTURE_CONTENT", "") in ("1", "true")


def _opt_in_latest_gen_ai_conventions() -> None:
    """Append ``gen_ai_latest_experimental`` to the semconv opt-in env var.

    The env var is comma-separated and read by OTel instrumentation at
    ``instrument()`` time, so setting it here (before auto-instrumentation
    runs) is early enough. An existing opt-in list is preserved.
    """
    current = os.environ.get(_SEMCONV_OPT_IN_ENV, "")
    values = [v.strip() for v in current.split(",") if v.strip()]
    if _SEMCONV_OPT_IN_VALUE not in values:
        values.append(_SEMCONV_OPT_IN_VALUE)
        os.environ[_SEMCONV_OPT_IN_ENV] = ",".join(values)


def init(
    *,
    endpoint: str | None = None,
    service_name: str | None = None,
    capture_content: bool | None = None,
    pricing: PricingMap | None = None,
    instrument: Sequence[str] | None = None,
    headers: dict[str, str] | None = None,
    span_processor: SpanProcessor | None = None,
) -> None:
    """Initialize TraceBloom tracing. Idempotent: a second call is a no-op
    until :func:`shutdown`.

    Args:
        endpoint: Collector OTLP/HTTP base URL; ``/v1/traces`` is appended.
            Defaults to ``TRACEBLOOM_ENDPOINT`` or ``http://localhost:4318``.
        service_name: Logical service name recorded on every span. Defaults to
            ``OTEL_SERVICE_NAME`` or ``tracebloom-app``.
        capture_content: Record prompt/response content as span events. Off by
            default (and via ``TRACEBLOOM_CAPTURE_CONTENT=1``) so no content
            leaves the process unless explicitly opted in.
        pricing: Override the token pricing map used for cost computation.
        instrument: Which provider libraries / agent frameworks to
            auto-instrument. Defaults to ``("openai", "anthropic")``; the
            framework integrations — ``"langchain"``, ``"langgraph"``,
            ``"llama_index"``, ``"openai_agents"`` — are opt-in, e.g.
            ``instrument=["openai", "anthropic", "langgraph"]``. Pass ``[]``
            to disable auto-instrumentation entirely. Anything not installed
            is silently skipped.
        headers: Extra headers for the OTLP exporter (e.g. auth for a hosted
            collector).
        span_processor: Advanced/testing: use this span processor instead of
            the default OTLP batch processor (e.g. an in-memory processor in
            tests).
    """
    global _provider, _state
    if _provider is not None:
        return

    resolved_endpoint = endpoint or os.environ.get("TRACEBLOOM_ENDPOINT") or _DEFAULT_ENDPOINT
    resolved_service = service_name or os.environ.get("OTEL_SERVICE_NAME") or "tracebloom-app"
    resolved_capture = _env_capture_content() if capture_content is None else capture_content
    resolved_pricing = pricing if pricing is not None else DEFAULT_PRICING

    _opt_in_latest_gen_ai_conventions()
    if resolved_capture:
        # Content must ride the trace pipeline so the enrichment stage can
        # convert it to span events; with capture off the env var is left
        # alone: whatever an instrumentation captures anyway is stripped at
        # export (D2 is enforced either way).
        os.environ[_CAPTURE_CONTENT_ENV] = _CAPTURE_CONTENT_MODE

    if span_processor is None:
        exporter = OTLPSpanExporter(
            endpoint=f"{resolved_endpoint.rstrip('/')}/v1/traces",
            headers=headers,
        )
        # Batch export: spans leave on a background thread, never the hot path.
        span_processor = BatchSpanProcessor(exporter)

    provider = TracerProvider(resource=Resource.create({"service.name": resolved_service}))
    # Enrichment must be registered first: processors run in registration
    # order, so spans reach the exporting processor already normalized.
    provider.add_span_processor(TraceBloomSpanProcessor(resolved_pricing, resolved_capture))
    provider.add_span_processor(span_processor)

    # Claim the global provider only if the app hasn't installed one; either
    # way the SDK always uses its own handle, so TraceBloom spans export to the
    # collector even when another provider owns the global slot.
    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(provider)

    to_instrument = DEFAULT_INSTRUMENTATIONS if instrument is None else tuple(instrument)
    instrumented = apply_instrumentations(to_instrument, provider)

    _provider = provider
    _state = RuntimeState(
        tracer=provider.get_tracer(_TRACER_NAME, _TRACER_VERSION),
        pricing=resolved_pricing,
        capture_content=resolved_capture,
        instrumented=instrumented,
    )


def shutdown() -> None:
    """Flush and tear down the tracer provider (and undo auto-instrumentation).
    Safe to call when not initialized."""
    global _provider, _state
    provider = _provider
    _provider = None
    _state = None
    remove_instrumentations()
    if provider is not None:
        provider.shutdown()


def get_state() -> RuntimeState:
    """Internal: the active runtime state; raise a helpful error if init() was skipped."""
    if _state is None:
        raise RuntimeError(
            "TraceBloom is not initialized. Call init() once at startup before instrumenting calls."
        )
    return _state
