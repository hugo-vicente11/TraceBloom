"""Runnable example: a LlamaIndex ReActAgent captured by TraceBloom.

``tracebloom.init(instrument=["llama_index"])`` turns a real LlamaIndex agent
workflow into a gen_ai trace — the workflow steps, each LLM call, and the tool
execution — all rewritten to the same canonical shape as every other
integration. The LLM is scripted in-process (no API key, no network).

Prerequisites — collector + ClickHouse + dashboard up (see repo root)::

    pnpm stack:up
    pnpm --filter @tracebloom/dashboard dev

Run it::

    uv run --project packages/sdk-py --extra llamaindex \\
        python examples/llamaindex_researcher.py
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from llama_index.core.agent.workflow import ReActAgent
from llama_index.core.llms import (
    ChatMessage,
    ChatResponse,
    ChatResponseAsyncGen,
    ChatResponseGen,
    CompletionResponse,
    CompletionResponseGen,
    CustomLLM,
    LLMMetadata,
)
from llama_index.core.llms.callbacks import llm_chat_callback, llm_completion_callback
from llama_index.core.tools import FunctionTool

import tracebloom

MODEL = "gpt-4o-2024-08-06"
DASHBOARD_URL = os.environ.get("TRACEBLOOM_DASHBOARD_URL", "http://localhost:3000")


class ScriptedLLM(CustomLLM):
    """Requests the search tool once, then produces a refusing final answer."""

    calls: int = 0

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(model_name=MODEL, is_function_calling_model=False)

    def _respond(self) -> ChatResponse:
        self.calls += 1
        if self.calls == 1:
            content = (
                "Thought: I should search for sources.\n"
                'Action: web_search\nAction Input: {"query": "otel genai agents"}'
            )
        else:
            content = (
                "Thought: The sources conflict and I cannot verify the claims.\n"
                "Answer: I cannot draft a confident comparison from this material."
            )
        return ChatResponse(
            message=ChatMessage(role="assistant", content=content),
            additional_kwargs={
                "prompt_tokens": 110,
                "completion_tokens": 42,
                "total_tokens": 152,
            },
        )

    @llm_chat_callback()
    def chat(self, messages: Any, **kwargs: Any) -> ChatResponse:
        return self._respond()

    @llm_chat_callback()
    async def astream_chat(self, messages: Any, **kwargs: Any) -> ChatResponseAsyncGen:
        response = self._respond()

        async def gen() -> ChatResponseAsyncGen:
            yield ChatResponse(
                message=response.message,
                delta=response.message.content or "",
                additional_kwargs=response.additional_kwargs,
            )

        return gen()

    @llm_completion_callback()
    def complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponse:
        raise NotImplementedError

    def stream_complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> CompletionResponseGen:
        raise NotImplementedError

    def stream_chat(self, messages: Any, **kwargs: Any) -> ChatResponseGen:
        raise NotImplementedError


def web_search(query: str) -> str:
    """Search the public web for recent, citable sources."""
    return (
        "results: [tracebloom.dev/docs, github.com/open-telemetry/semantic-conventions]"
    )


async def run() -> None:
    agent = ReActAgent(
        name="researcher",
        tools=[FunctionTool.from_defaults(fn=web_search)],
        llm=ScriptedLLM(),
    )
    with tracebloom.prompt_version("v1", "research"):
        result = await agent.run(
            user_msg="how do teams monitor LLM agents in production?"
        )
    print("agent said:", str(result)[:80], "…")


def main() -> None:
    tracebloom.init(
        service_name="llamaindex-example",
        capture_content=True,
        instrument=["llama_index"],
    )
    if "llama_index" not in tracebloom.get_state().instrumented:
        raise SystemExit(
            "LlamaIndex instrumentation did not load. Install the extra:\n"
            "  uv run --project packages/sdk-py --extra llamaindex ..."
        )

    asyncio.run(run())

    tracebloom.shutdown()
    time.sleep(1.0)
    print(
        f"\n▶ Open {DASHBOARD_URL}/traces and click the newest 'llamaindex-example' trace."
    )


if __name__ == "__main__":
    main()
