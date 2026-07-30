"""SDK lifecycle: init/shutdown semantics and the uninitialized error."""

from __future__ import annotations

import os
from unittest import mock

import pytest

import tracebloom
from tests.conftest import SdkFactory


def test_version_is_exposed() -> None:
    assert tracebloom.__version__ == "0.1.0"


def test_get_state_before_init_raises() -> None:
    with pytest.raises(RuntimeError, match="not initialized"):
        tracebloom.get_state()


def test_shutdown_without_init_is_safe() -> None:
    tracebloom.shutdown()


def test_init_is_idempotent(sdk: SdkFactory) -> None:
    sdk(capture_content=True)
    # Second init must be a no-op: capture_content stays as configured first.
    tracebloom.init(capture_content=False)
    assert tracebloom.get_state().capture_content is True


def test_capture_content_defaults_off(sdk: SdkFactory) -> None:
    sdk()
    assert tracebloom.get_state().capture_content is False


def test_capture_content_env_toggle(sdk: SdkFactory) -> None:
    with mock.patch.dict(os.environ, {"TRACEBLOOM_CAPTURE_CONTENT": "1"}):
        sdk()
        assert tracebloom.get_state().capture_content is True


def test_init_opts_into_latest_gen_ai_conventions(sdk: SdkFactory) -> None:
    with mock.patch.dict(os.environ, {"OTEL_SEMCONV_STABILITY_OPT_IN": "http"}):
        sdk()
        values = os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"].split(",")
        assert "http" in values
        assert "gen_ai_latest_experimental" in values
