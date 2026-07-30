# Framework integration examples

Each script is a **real** agent from a popular framework, captured by TraceBloom
with one line of setup. The LLM is scripted in-process, so every example runs
with **no API key and no network to the model**, yet produces a genuine
multi-step trace (plan → a tool that fails and is retried → a deliberately
refusing draft), which streams live into the dashboard and is scored by the
sample `no-refusal` eval.

First bring up the collector, ClickHouse and the dashboard from the repo root:

```bash
pnpm stack:up                              # collector + ClickHouse on :4318 / :8123
pnpm --filter @tracebloom/dashboard dev    # dashboard on :3000
```

Then run any example and open the printed URL to watch its trace tree render.

| Framework | Integration | Command |
| --- | --- | --- |
| **LangGraph** (+ LangChain) | `instrument=["langgraph"]` | `uv run --project packages/sdk-py --extra langgraph python examples/langgraph_researcher.py` |
| **LlamaIndex** | `instrument=["llama_index"]` | `uv run --project packages/sdk-py --extra llamaindex python examples/llamaindex_researcher.py` |
| **Vercel AI SDK** | `createAISDKTelemetry()` | `pnpm --filter @tracebloom/examples vercel` |

All three map their framework concepts to the same `gen_ai` span shape, so a
LangGraph run and a LlamaIndex run render coherently in the same viewer, see
the semantic-mapping table in the top-level [README](../README.md#works-with-your-framework).
