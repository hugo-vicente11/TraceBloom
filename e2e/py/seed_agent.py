"""Seed a realistic multi-step agent trace from the PYTHON SDK for the trace
viewer demo — the LLM provider is mocked (no API key): a researcher agent that
plans with an auto-instrumented OpenAI call, hits a tool failure + retry, fans
out two parallel fetches, drafts an answer, records an SDK eval score, and
delegates to a sub-agent. Content capture is ON so the span detail panel shows
prompts/responses; one output deliberately contains "I cannot", so the sample
``no-refusal`` eval (pnpm eval:seed + eval:run) fails that span and the score
shows up red in the viewer. Mirrors ``e2e/src/seed-agent.ts``.

Requires the collector + ClickHouse to be up (pnpm stack:up). Run with:

    pnpm seed:agent:py
    # = uv run --project packages/sdk-py python e2e/py/seed_agent.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass

import httpx
import openai

import tracebloom

COLLECTOR_ENDPOINT = os.environ.get("TRACEBLOOM_ENDPOINT", "http://localhost:4318")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
CLICKHOUSE_DATABASE = os.environ.get("CLICKHOUSE_DATABASE", "tracebloom")
DASHBOARD_URL = os.environ.get("TRACEBLOOM_DASHBOARD_URL", "http://localhost:3000")
SERVICE_NAME = "agent-demo-py"
EXPECTED_SPANS = 9


@dataclass(frozen=True)
class CannedReply:
    model: str
    content: str
    input_tokens: int
    output_tokens: int
    delay_s: float


REPLIES = {
    "plan": CannedReply(
        model="gpt-4o-2024-08-06",
        content=(
            "Plan: (1) search the web for recent TraceBloom coverage, (2) fetch the two "
            "most relevant pages, (3) draft an answer with citations, (4) hand off to "
            "the summarizer."
        ),
        input_tokens=138,
        output_tokens=61,
        delay_s=0.16,
    ),
    "draft": CannedReply(
        model="gpt-4o-2024-08-06",
        content=(
            "Draft: TraceBloom is an open-source observability and evaluation layer for "
            "LLM agents. I cannot verify the funding rumor from the sources fetched, so "
            "it is omitted."
        ),
        input_tokens=512,
        output_tokens=74,
        delay_s=0.21,
    ),
    "summarize": CannedReply(
        model="gpt-4o-mini",
        content=(
            "TraceBloom: open-source, OTel-native tracing + evals for LLM agents; "
            "self-hostable; evaluation engine scores captured traffic for regressions."
        ),
        input_tokens=96,
        output_tokens=38,
        delay_s=0.12,
    ),
}


def mock_openai() -> openai.AsyncOpenAI:
    """OpenAI client with a mocked transport: canned replies keyed by the first
    word of the last user message. The real client + real instrumentation run;
    only HTTP is faked, so this needs no API key and makes no network calls."""

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        last = payload["messages"][-1]["content"]
        key = last.split(":")[0] if isinstance(last, str) else "plan"
        reply = REPLIES.get(key, REPLIES["plan"])
        await asyncio.sleep(reply.delay_s)
        return httpx.Response(
            200,
            json={
                "id": f"chatcmpl-{key}-{int(time.time() * 1000):x}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": reply.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": reply.content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": reply.input_tokens,
                    "completion_tokens": reply.output_tokens,
                    "total_tokens": reply.input_tokens + reply.output_tokens,
                },
            },
        )

    return openai.AsyncOpenAI(
        api_key="mock-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def flaky_search(attempt: int) -> str:
    await asyncio.sleep(0.09 if attempt == 1 else 0.13)
    if attempt == 1:
        raise RuntimeError("rate limited (429) from search provider")
    return "results: [tracebloom.dev, github.com/tracebloom]"


async def run_agent() -> str:
    client = mock_openai()
    trace_id = ""

    with tracebloom.agent_span("researcher", agent_id="agent-researcher-1") as root:
        trace_id = f"{root.get_span_context().trace_id:032x}"

        with tracebloom.prompt_version("v2", "research"):
            # 1. Plan with an auto-instrumented LLM call (zero extra code).
            await client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "plan: research TraceBloom and summarize it"}],
            )

            # 2. Tool call that fails once and is retried (one span per attempt).
            for attempt in (1, 2):
                try:
                    with tracebloom.tool_span(
                        "web.search",
                        call_id="call-search-1",
                        description="Search the public web",
                        retry_attempt=attempt,
                    ):
                        await flaky_search(attempt)
                    break
                except RuntimeError as error:
                    if attempt >= 2:
                        raise
                    print(f"[seed-agent-py] tool failed (attempt {attempt}), retrying: {error}")

            # 3. Two parallel page fetches: overlapping bars in the waterfall.
            async def fetch(call_id: str, delay_s: float) -> None:
                with tracebloom.tool_span("web.fetch", call_id=call_id):
                    await asyncio.sleep(delay_s)

            await asyncio.gather(fetch("call-fetch-1", 0.15), fetch("call-fetch-2", 0.10))

            # 4. Draft the answer (this output trips the sample no-refusal eval),
            #    and record an SDK eval score the runner will promote.
            await client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "user", "content": "draft: write the answer from the fetched sources"}
                ],
            )
            tracebloom.record_evaluation(
                "user_feedback", score=1.0, label="thumbs_up", reason="clear and sourced"
            )

        # 5. Delegate to a sub-agent for the final summary.
        with tracebloom.agent_span("summarizer", agent_id="agent-summarizer-1"):
            await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "user", "content": "summarize: condense the draft to two sentences"}
                ],
            )

    return trace_id


def count_landed_spans(trace_id: str) -> int:
    query = (
        f"SELECT count() FROM {CLICKHOUSE_DATABASE}.spans "
        f"WHERE trace_id = '{trace_id}' FORMAT TabSeparated"
    )
    response = httpx.get(CLICKHOUSE_URL, params={"query": query}, timeout=10.0)
    response.raise_for_status()
    return int(response.text.strip() or "0")


def main() -> None:
    print(f"[seed-agent-py] collector={COLLECTOR_ENDPOINT} service={SERVICE_NAME}")
    tracebloom.init(
        endpoint=COLLECTOR_ENDPOINT,
        service_name=SERVICE_NAME,
        capture_content=True,
    )
    trace_id = asyncio.run(run_agent())
    tracebloom.shutdown()  # flushes the batch exporter
    print(f"[seed-agent-py] trace {trace_id} exported; waiting for ClickHouse...")

    landed = 0
    for _ in range(40):
        landed = count_landed_spans(trace_id)
        if landed >= EXPECTED_SPANS:
            break
        time.sleep(0.5)
    if landed != EXPECTED_SPANS:
        print(f"[seed-agent-py] ❌ expected {EXPECTED_SPANS} spans to land, got {landed}")
        sys.exit(1)

    print(f"[seed-agent-py] ✅ {landed} spans landed for trace {trace_id}")
    print("[seed-agent-py] open the waterfall viewer:")
    print(f"[seed-agent-py]   {DASHBOARD_URL}/traces/{trace_id}")
    print(
        "[seed-agent-py] score it: pnpm eval:seed && pnpm eval:run   (then reload the trace page)"
    )


if __name__ == "__main__":
    main()
