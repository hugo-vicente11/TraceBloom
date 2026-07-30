"""Shared fixtures: initialize the SDK against an in-memory exporter.

Every test gets a fresh provider via ``init(span_processor=...)`` (the same
testing escape hatch the TS SDK exposes) and a guaranteed ``shutdown()``
afterwards, so tests never leak tracer state into each other and never open a
network connection.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Protocol

import pytest
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import tracebloom


class SdkFactory(Protocol):
    """Initialize the SDK with the given ``init()`` kwargs; returns the exporter."""

    def __call__(self, **kwargs: Any) -> InMemorySpanExporter: ...


@pytest.fixture
def sdk() -> Iterator[SdkFactory]:
    exporter = InMemorySpanExporter()

    def _init(**kwargs: Any) -> InMemorySpanExporter:
        tracebloom.init(span_processor=SimpleSpanProcessor(exporter), **kwargs)
        return exporter

    yield _init
    tracebloom.shutdown()
