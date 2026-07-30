# tracebloom (Python SDK)

Emit OpenTelemetry `gen_ai` spans for LLM and agent operations to the
[TraceBloom](../../README.md) collector. Mirrors the
[TypeScript SDK](../sdk-ts), same surface, same semantics, same wire format
(see the [parity table](../../README.md#ts--python-parity)).

## Install

```bash
pip install 'tracebloom[openai]'      # with OpenAI auto-instrumentation
pip install 'tracebloom[anthropic]'   # with Anthropic auto-instrumentation
# extras: openai, anthropic, langchain (any combination)
```

## One-line setup

```python
import tracebloom

tracebloom.init(endpoint="http://localhost:4318", service_name="my-app")
```

That's it: every installed provider library is auto-instrumented via the
official OpenTelemetry instrumentation, so existing OpenAI / Anthropic calls
emit `gen_ai` spans (model, token usage, computed cost, latency, status) with
no other code changes. Libraries that aren't installed are silently skipped;
auto-instrumentation never crashes the host app. Spans leave through an OTLP
batch exporter on a background thread, the hot path is never blocked.

`init` options (env fallbacks in parentheses): `endpoint`
(`TRACEBLOOM_ENDPOINT`), `service_name` (`OTEL_SERVICE_NAME`),
`capture_content` (`TRACEBLOOM_CAPTURE_CONTENT=1`), `pricing`,
`instrument=["openai", "anthropic"]` (pass `[]` to disable), `headers`.

## Agent & tool spans

Context managers produce the `invoke_agent` / `execute_tool` parent–child
trees the trace viewer renders; OTel context propagation (async-safe) nests
any instrumented LLM call made inside them:

```python
with tracebloom.agent_span("researcher", agent_id="agent-1"):
    plan = client.chat.completions.create(...)     # child of the agent span
    with tracebloom.tool_span("web.search", call_id="c1", retry_attempt=2):
        results = search(query)
```

Raising inside a block marks the span as an error (with the exception
recorded) and re-raises, wrap each retry attempt to get one span per try.

## Variants & eval hooks

```python
# Tag every span started in the block (incl. auto-instrumented calls) with
# gen_ai.prompt.version — the evaluation engine compares variants by it:
with tracebloom.prompt_version("v2", "research"):
    client.chat.completions.create(...)

tracebloom.set_prompt_version("v2")   # or: tag just the active span

# Attach feedback/scores; the eval runner promotes them into eval_results:
tracebloom.record_evaluation("user_feedback", score=1.0, label="thumbs_up")
```

## Content capture (off by default)

Prompt/response content is only recorded with `capture_content=True` (or
`TRACEBLOOM_CAPTURE_CONTENT=1`), and only as **span events**
(`gen_ai.user.message`, `gen_ai.choice`, …), never as span attributes, no
matter what an instrumentation emits. Off by default so no content leaves the
process unless explicitly enabled.

## Cost

Computed from the repo's canonical pricing map
([`pricing/model-prices.json`](../../pricing/model-prices.json)), shared with
the TS SDK, a fixture test pins both SDKs to identical results. Override per
app with `init(pricing={...})`.

## Development

Managed with [uv](https://docs.astral.sh/uv/):

```bash
cd packages/sdk-py
uv sync            # venv + deps (incl. dev group)
uv run pytest      # unit tests (integration is env-gated, see below)
uv run mypy        # strict type-check (py.typed package)
uv run ruff check

# SDK → collector → ClickHouse integration test (pnpm stack:up first):
TRACEBLOOM_TEST_COLLECTOR_URL=http://localhost:4318 \
TRACEBLOOM_TEST_CLICKHOUSE_URL=http://localhost:8123 uv run pytest tests/integration
```

A full demo agent trace (mocked provider, no API key): `pnpm seed:agent:py`
from the repo root.
