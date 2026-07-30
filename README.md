# TraceBloom

**See what your LLM agents actually do, and whether it's any good.**

[![CI](https://github.com/hugo-vicente11/TraceBloom/actions/workflows/ci.yml/badge.svg)](https://github.com/hugo-vicente11/TraceBloom/actions/workflows/ci.yml)
[![Security](https://github.com/hugo-vicente11/TraceBloom/actions/workflows/security.yml/badge.svg)](https://github.com/hugo-vicente11/TraceBloom/actions/workflows/security.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![OpenTelemetry-native](https://img.shields.io/badge/OpenTelemetry-native-425CC7?logo=opentelemetry&logoColor=white)](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

TraceBloom is an open-source, vendor-neutral **observability + evaluation**
layer for LLM and agent applications. One line of SDK setup turns agent runs
into live waterfall traces (every model call with tokens and cost, every tool
step, retry, failure and sub-agent), while an evaluation engine scores real
traffic out-of-band, compares prompt variants, and flags regressions before
your users notice them. Built on **OpenTelemetry GenAI semantic conventions**,
canonical OTLP on the wire, self-hostable with one command, Apache-2.0.

**[▶ Open the live demo](https://tracebloom.hugovicente.dev)** · [Quickstart](#quickstart-from-clone-to-a-visible-trace) · [Self-host guide](docs/self-hosting.md) · [Roadmap](#roadmap)

<!--
  HERO GIF, the first thing visitors see. Record it with the "GIF recording
  script" in the launch handoff and save as docs/live-trace-viewer.gif (the
  Live tracing section below reuses the same file). ~1400px capture, loop, <8 MB.
-->
<p align="center">
  <a href="https://tracebloom.hugovicente.dev">
    <img src="docs/live-trace-viewer.gif" width="840"
      alt="TraceBloom live trace viewer: a researcher agent streams in as a tree + waterfall, a web-search tool call flips red, its retry lands beside it, and a failing no-refusal eval chip pops onto the refusing draft." />
  </a>
</p>

> **Status: Milestone 7** (framework integrations): point TraceBloom at
> your existing agent stack (LangChain + LangGraph, LlamaIndex, OpenAI Agents
> SDK, Vercel AI SDK) with one line and the whole run is captured, evaluated
> and streamed live. See [Works with your framework](#works-with-your-framework).
> This builds on the public demo + landing page (M6), live tracing (M5), the
> Python SDK (M4), the agent trace viewer (M3), the evaluation engine (M2) and
> the core loop (M1); the bounded **"run a live agent"** sandbox now runs a
> real Vercel AI SDK agent. See [the public demo](#the-public-demo) and the
> [roadmap](#roadmap).

## The public demo

The demo **is the real dashboard** pointed at real telemetry, not a mock UI.
Opening it drops you into a curated project with a week of researcher-agent
traffic:

- **Multi-step agent traces**: plan → flaky web search (fails, retries) →
  parallel fetches → draft → summarizer sub-agent; some runs fail outright.
  Click any trace for the tree + waterfall, span content and eval chips.
- **A visible regression**: prompt **v2** shipped ~36h ago and refuses too
  often; the `no-refusal` eval's pass rate drops and the **real** regression
  detector flags it (Evals → no-refusal → v2, red).
- **A live run on demand**: the **▶ Run a live agent** button starts a fresh
  sandboxed run (mock LLM, no keys anywhere) that streams into the viewer
  over SSE: the tool call flips red, its retry lands beside it, and the eval
  runner pins a failing chip on the refusing draft while you watch.

The public path is **provably read-only**: the dashboard holds SELECT-only
database credentials, only the reverse proxy is network-exposed, and every
mutating action refuses in demo mode. The sandbox is rate-limited,
concurrency-capped and daily-budgeted (DECISIONS.md D24–D27, all asserted in
CI). Want this exact stack yourself? It is one command:
[docs/self-hosting.md](docs/self-hosting.md).

## Architecture

```mermaid
flowchart LR
  subgraph app["Your application"]
    sdkts["@tracebloom/sdk (TypeScript)"]
    sdkpy["tracebloom (Python)"]
  end

  sdkts -- "OTLP/HTTP (protobuf)<br/>gen_ai spans" --> col
  sdkpy -. "soon" .-> col

  subgraph tb["TraceBloom"]
    col["Collector<br/>(Rust · axum + tokio)<br/>POST /v1/traces · /health"]
    ch[("ClickHouse<br/>spans · span_events · eval_results")]
    pg[("Postgres<br/>projects · eval_definitions · regressions")]
    runner["Eval runner<br/>(TS worker · out-of-band)"]
    dash["Dashboard<br/>(Next.js · trace viewer + evals)"]
  end

  col -- "batched async writes" --> ch
  runner -- "reads landed spans" --> ch
  runner -- "writes eval_results" --> ch
  runner -. "eval defs · regressions" .-> pg
  runner -- "judge calls (instrumented)" --> col
  dash -- "SQL (traces · scores)" --> ch
  dash -. "eval config" .-> pg
```

- **Content safety:** prompt/response content is stored as span **events** (never
  as indexed span attributes), and capture is **off by default**.
- **Standard wire format:** the collector ingests canonical **OTLP/HTTP
  protobuf**; any OpenTelemetry SDK can point at it.

- **Production topology:** the same stack deploys to one small VM behind
  Caddy (automatic HTTPS); databases and the collector are internal-only and
  the public dashboard runs on read-only credentials. One-command deploy:
  [docs/self-hosting.md](docs/self-hosting.md).

See [DECISIONS.md](DECISIONS.md) for the non-obvious engineering choices.

## Locked stack

All versions verified against their registries on 2026-06-28; exact pins live in
`Cargo.lock`, `pnpm-lock.yaml`, and `packages/sdk-py/uv.lock`.

| Area | Tooling | Version |
|------|---------|---------|
| Collector | Rust (edition 2024) · axum · tokio | 1.95.0 · 0.8 · 1.52 |
| | opentelemetry-proto · prost · clickhouse | 0.32 · 0.14 · 0.14 |
| Workspace | Node.js · pnpm · Turborepo · Biome | 24 LTS · 11.9.0 · 2.10.0 · 2.5.1 |
| Shared TS | TypeScript · Vitest | 6.0 · 4.1 |
| SDK (TS) | @opentelemetry/api · sdk-trace-* · exporter-trace-otlp-proto | 1.9.1 · 2.8.0 · 0.219.0 |
| Eval engine | ajv · ajv-formats · openai (judge client) | 8.20 · 3.0 · 6.45 |
| Dashboard | Next.js · React · Tailwind · @clickhouse/client | 16.2 · 19.2 · 4.3 · 1.22 |
| Postgres | Drizzle ORM · drizzle-kit | 0.45.2 · 0.31.10 |
| SDK (Python) | Python · uv · opentelemetry-sdk | 3.14 · 0.11.28 · 1.43 |
| | opentelemetry-instrumentation-openai-v2 / -anthropic | 2.4b0 · 0.62 (verified 2026-07-16) |
| | pytest · mypy · ruff | 9.1 · 2.3 · 0.15 |
| Infra | ClickHouse · Postgres (images) | `26.3` (LTS) · `18-alpine` |
| Edge (prod) | Caddy (image) | `2.11.4-alpine` (verified 2026-07-19) |

> TypeScript 7.0 (the Go-native compiler) was at RC at project start; we pin the
> current stable **6.0** and will move once the ecosystem settles.

## Repository layout

```
apps/
  collector/   Rust OTLP/HTTP collector → ClickHouse (lib + bin, tested)
  dashboard/   Next.js — landing page + trace viewer (tree/waterfall) + Evals + try-it sandbox
  demo/        @tracebloom/demo — curated demo corpus: seed / reset / verify
  eval-runner/ @tracebloom/eval-runner — async worker: score spans, detect regressions
packages/
  sdk-ts/      @tracebloom/sdk — gen_ai span emission + cost + auto-instrument + variant tagging
  sdk-py/      tracebloom — Python SDK: one-line auto-instrumentation (OpenAI/Anthropic),
               agent/tool spans, cost, variants, eval hooks (uv-managed, typed)
  eval/        @tracebloom/eval — evaluator framework (deterministic + LLM-judge)
  db/          @tracebloom/db — Drizzle schema + migrations for Postgres
pricing/       canonical model pricing map + cost-parity fixture (consumed by BOTH SDKs)
e2e/           mock-provider smoke test + Python agent seed (SDK → collector → ClickHouse)
infra/
  clickhouse/  schema migrations (+ first-boot init) and migrate.sh
  prod/        single-VM production stack: compose + Caddyfile + deploy.sh + smoke.sh
  docker-compose.yml
docs/          self-hosting guide
```

## Prerequisites

Docker (+ Compose v2), Node.js 24, pnpm 11, and Rust 1.95 (only needed to build
the collector locally; the compose stack builds it in a container). Exact
toolchain install commands for your OS are in the project setup notes.

## Quickstart: from clone to a visible trace

```bash
git clone <repo-url> tracebloom && cd tracebloom
pnpm install

# 1. Bring up ClickHouse + Postgres + the collector (one command).
#    ClickHouse applies its migrations automatically on first boot.
pnpm stack:up

# 2. Build the TypeScript SDK (the smoke test imports it).
pnpm build

# 3. Emit a trace with a MOCKED provider (no API key) and assert it lands.
pnpm smoke
#    → [smoke] ✅ trace <id> — model=gpt-4o tokens=18 cost=$0.0000975

# 4. See it in the dashboard — click the trace to open the waterfall viewer.
pnpm --filter @tracebloom/dashboard dev
#    → open http://localhost:3000  (landing; traces live at /traces)

# Optional: load the full curated demo locally — a week of researcher-agent
# traffic, eval scores and the v2 regression (then run the evals once).
pnpm db:migrate && pnpm demo:seed && pnpm eval:run
```

Instrument your own app:

```ts
import OpenAI from 'openai';
import { init, instrumentOpenAI } from '@tracebloom/sdk';

init({ endpoint: 'http://localhost:4318', serviceName: 'my-app' });
const openai = instrumentOpenAI(new OpenAI());

// Every chat.completions.create now emits a gen_ai span with model,
// token usage, computed cost, latency and status.
await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Python SDK

`tracebloom` (in `packages/sdk-py`, `uv`-managed, fully typed + `py.typed`) is
the Python twin of `@tracebloom/sdk`. One line auto-instruments every installed
provider library, existing OpenAI / Anthropic calls start flowing into
TraceBloom with **no other code changes**:

```python
import tracebloom

tracebloom.init(endpoint="http://localhost:4318", service_name="my-app")

# ...existing code, unchanged — every call now emits a gen_ai span with
# model, token usage, computed cost, latency and status:
client = openai.OpenAI()
client.chat.completions.create(model="gpt-4o", messages=[...])
```

Auto-instrumentation is delegated to the OpenTelemetry instrumentation
packages (`opentelemetry-instrumentation-openai-v2`,
`opentelemetry-instrumentation-anthropic`), install the matching extra, e.g.
`pip install 'tracebloom[openai]'`. Libraries that aren't installed are
silently skipped; instrumentation can never crash the host app. Configure the
set with `init(instrument=["openai"])` or disable it with `instrument=[]`.
Whole **agent frameworks**, LangGraph, LlamaIndex, the OpenAI Agents SDK —
plug into the same `instrument=[...]` registry (opt-in); see
[Works with your framework](#works-with-your-framework).

Multi-step agents, variants, and feedback use the same building blocks as TS:

```python
with tracebloom.agent_span("researcher"):                  # invoke_agent span
    with tracebloom.prompt_version("v2", "research"):      # variant tag on every
        plan = client.chat.completions.create(...)         # span started inside
    with tracebloom.tool_span("web.search", call_id="c1"): # execute_tool span
        results = search(query)
    tracebloom.record_evaluation("user_feedback", score=1.0, label="thumbs_up")
```

Prompt/response content is captured **only** with
`init(capture_content=True)` (or `TRACEBLOOM_CAPTURE_CONTENT=1`) and only as
span events, never as span attributes, matching the system-wide content
rule. Costs come from the repo's canonical pricing map, shared with the TS
SDK. Seed a full demo agent run from Python (mocked provider, no API key):

```bash
pnpm seed:agent:py    # → 9-span multi-step trace + SDK eval score in the viewer
```

### TS ↔ Python parity

Both SDKs expose the same surface with the same semantics, shared mental
model, shared pricing, identical wire format:

| Concept                | TypeScript (`@tracebloom/sdk`)          | Python (`tracebloom`)                     |
| ---------------------- | --------------------------------------- | ----------------------------------------- |
| Setup / teardown       | `init(config)` / `shutdown()`           | `init(**config)` / `shutdown()`           |
| Auto-instrumentation   | `instrumentOpenAI(client, tag?)` (wrap) | `init(instrument=[...])` (patches libs)   |
| Agent step             | `withAgentSpan(opts, fn)`               | `with agent_span(name, ...):`             |
| Tool step              | `withToolSpan(opts, fn)`                | `with tool_span(name, ...):`              |
| Variant tag (active)   | `setPromptVersion(v, name?)`            | `set_prompt_version(v, name=None)`        |
| Variant tag (scoped)   | `instrumentOpenAI(client, { promptVersion })` | `with prompt_version(v, name):`     |
| Eval hook              | `recordEvaluation(name, record)`        | `record_evaluation(name, score=..., ...)` |
| Cost                   | shared `pricing/model-prices.json`      | same file, cost parity is test-enforced  |

The one deliberate difference: TS wraps a client you pass in (explicit,
tree-shakeable); Python patches the installed library via OTel instrumentation
(the ecosystem norm), so the scoped `prompt_version(...)` context manager
replaces the per-client tag.

## Works with your framework

Already building on an agent framework? Point TraceBloom at it and the whole
run shows up, agent steps, tool calls, retries, sub-agents, as the same
`gen_ai` trace tree the rest of the system renders, evaluates and streams
live. Each integration rides the framework's **native hook** (its own callback
/ telemetry / trace-processor system) or an existing OpenTelemetry-ecosystem
instrumentor, **no monkey-patching of framework internals**, and TraceBloom
adapts the output at the edge so cost, the content toggle, variant tags and
eval hooks behave identically to the manual paths.

One line per framework:

```python
# Python — opt in per framework (silent no-op if the library isn't installed)
tracebloom.init(instrument=["langgraph"])       # LangChain + LangGraph
tracebloom.init(instrument=["llama_index"])     # LlamaIndex
tracebloom.init(instrument=["openai_agents"])   # OpenAI Agents SDK
# extras: pip install 'tracebloom[langgraph]'  (llamaindex / openai-agents)
```

```ts
// TypeScript — Vercel AI SDK, via its built-in telemetry hook
import { generateText, registerTelemetry } from 'ai';
import { init, createAISDKTelemetry } from '@tracebloom/sdk';
init();
registerTelemetry(createAISDKTelemetry());
await generateText({ model, prompt, telemetry: { functionId: 'researcher' } });
```

**How each is captured** (existing OTel/OpenInference instrumentation vs. a
native callback, DECISIONS.md D29–D31):

| Framework | Package (verified) | Native hook it rides |
| --- | --- | --- |
| LangChain + LangGraph | `opentelemetry-instrumentation-langchain` 0.62.1 | LangChain callback system + LangGraph `Pregel` wrappers |
| LlamaIndex | `openinference-instrumentation-llama-index` 4.4.3 | LlamaIndex instrumentation dispatcher |
| OpenAI Agents SDK | `openinference-instrumentation-openai-agents` 1.6.1 | Agents SDK `set_trace_processors` |
| Vercel AI SDK | `@tracebloom/sdk` `createAISDKTelemetry()` | AI SDK `registerTelemetry` / `telemetry.integrations` |

**Semantic mapping**: every framework's concepts collapse onto the same small
`gen_ai` vocabulary, so a LangGraph run and a LlamaIndex run categorize and
render identically in the viewer:

| Framework concept | `gen_ai.operation.name` | Category |
| --- | --- | --- |
| Run / workflow / graph; sub-agent, delegation | `invoke_agent` | agent |
| Graph node · LlamaIndex step/chain/retriever · agent turn · AI SDK step | `execute_task` | generic |
| Model / chat call (with model, token usage, cost) | `chat` | llm |
| Tool / function call (with tool name, args, result) | `execute_tool` | tool |
| Embedding call | `embeddings` | llm |

Cost is computed from the shared `pricing/model-prices.json`; content rides the
same D2 rule (span events, off unless `capture_content=True`); the
`prompt_version(...)` tag lands on every framework span; and `record_evaluation`
attaches to the active TraceBloom span, wrap a framework run in `agent_span`
and the eval lands there with the whole run nested underneath. Runnable
examples for all four (scripted models, no API keys) live in
[`examples/`](examples/README.md).

## Agent trace viewer

*What did this agent actually do, step by step, and where did it go wrong?*
Click any trace on the dashboard and TraceBloom reconstructs the run from its
OTLP parent/child links into a collapsible **span tree aligned with a waterfall
timeline**: every LLM call, tool execution, retry and sub-agent as a bar
positioned by start offset and sized by duration, so latency, sequencing and
parallelism are visible at a glance.

<!-- DEMO HERO: replace with a screenshot/GIF of /traces/<id> showing the
     researcher-agent waterfall (tool retry + failing eval chip visible).
     Suggested capture: pnpm seed:agent && pnpm eval:seed && pnpm eval:run,
     then open the printed URL at ~1400px wide. -->
![Agent trace viewer, tree + waterfall](docs/trace-viewer.png)

- **Span kinds at a glance**: LLM calls, tool executions (`gen_ai.tool.*`),
  agent/sub-agent spans (`invoke_agent`) and generic spans each get their own
  icon + color; **errors are red** with the status message one hover away, and
  **retries** (`tracebloom.retry.attempt ≥ 2`) carry a `↻ ×n` badge.
- **Roll-ups on parents**: every parent row shows its subtree's cumulative
  tokens and cost (`Σ`), plus subtree compute time and a red dot when a
  collapsed branch hides an error.
- **Eval scores inline**: results from the [evaluation engine](#evaluation-engine)
  render as pass/fail chips on the exact span they scored; the detail panel
  shows the judge's rationale.
- **Click a span** for the detail panel: prompt/response content (lazy-loaded
  span events, only fetched on click, and only if content capture was on),
  exceptions with stack traces, and the full attribute set.
- **Built to scale**: one ClickHouse query per trace, virtualized rows
  (smooth at 1,000+ spans), 10k-span safety cap, and graceful handling of
  orphaned spans and malformed parent links.
- **Find the trace you need**: the trace list filters by model, status,
  variant, time range, min cost/latency, and exact trace id; rows deep-link to
  `/traces/<traceId>?span=<spanId>`.

### Quickstart: seed a demo agent run

```bash
# Stack up (collector + ClickHouse + Postgres), then:
pnpm seed:agent          # researcher agent: plan → tool fail+retry →
                         # parallel fetches → draft → summarizer sub-agent
#   → [seed-agent] ✅ 9 spans landed for trace <id>
#   → open http://localhost:3000/traces/<id>

# Optional: score the run so eval chips appear on the chat spans
# (the draft deliberately trips the sample `no-refusal` eval).
pnpm eval:seed && pnpm eval:run
```

Instrument your own agent with the same two helpers the demo uses:

```ts
import { init, instrumentOpenAI, withAgentSpan, withToolSpan } from '@tracebloom/sdk';

init({ serviceName: 'my-agent' });
const openai = instrumentOpenAI(new OpenAI());

await withAgentSpan('researcher', async () => {
  const plan = await openai.chat.completions.create({ ... }); // nests automatically
  await withToolSpan({ name: 'web.search', retryAttempt: 1 }, () => search(q));
  await withAgentSpan('summarizer', () => summarize());       // sub-agent
});
```

## Live tracing: watch an agent run in real time

Open a trace **while the agent is still running** and the viewer becomes a
cockpit: spans appear as each step completes, still-open parents render as
pulsing **in-progress bars that grow** against a ticking timeline, a failed
tool call **flips red** and its retry lands beside it, the whole trace stays
**LIVE** until the root span completes, and when the async evaluator scores a
step, the **eval chip pops onto the span** in front of you.

<!-- DEMO HERO (live): replace with a GIF of the live viewer. Suggested
     capture: `pnpm seed:agent:live`, open the printed URL immediately, and
     record ~45s at ~1400px wide, the pending root filling in, the tool
     error + retry, parallel fetch bars growing, the LIVE badge flipping to
     OK, then `pnpm eval:seed && pnpm eval:run` making chips pop in.
     Bonus second clip: the "▶ Replay arrival" button on the finished trace. -->
![Live trace viewer, spans streaming in while the agent runs](docs/live-trace-viewer.gif)

- **Streaming over SSE with an exact-resume cursor**: the browser subscribes
  to `/api/traces/:id/live` (one-directional Server-Sent Events); every
  message carries a cursor as its SSE event id, so a dropped connection
  auto-reconnects via `Last-Event-ID` and resumes with **no gaps and no
  duplicates**. Backgrounded tabs pause the stream and resume from the same
  cursor when visible.
- **In-progress spans, inferred honestly**: OTel SDKs export a span when it
  *ends*, so a running step's children arrive before it does. The viewer
  extends M3's orphan handling: a referenced-but-missing parent becomes a
  *pending* node with a growing bar, replaced in place the moment the real
  span lands (running → complete/error).
- **The trace list goes live too**: running traces surface in a "Live now"
  rail above the table, updating as agents start and finish; finished traces
  drop into the regular table automatically.
- **Replay**: completed traces have a "▶ Replay arrival" button that
  re-animates the original span-arrival order (compressed to ~6s), pending
  placeholders and all. Great for demos of runs that already happened.
- **Zero impact on ingestion, by construction**: the live channel lives in
  the dashboard process and only *reads* ClickHouse with cursor-bounded
  per-trace delta queries (never a full re-fetch, never a busy-poll); one
  shared poller serves every subscriber of a trace, so load scales with
  watched traces, not open tabs. The collector is untouched, enforced by
  tests, including a source-level guard. See DECISIONS.md D20–D23.

### Quickstart: watch a live agent run

```bash
# Stack up + dashboard running (pnpm stack:up; pnpm --filter @tracebloom/dashboard dev), then:
pnpm seed:agent:live     # slow-motion researcher agent (~40s)
#   ┌──────────────────────────────────── WATCH IT LIVE ─┐
#      http://localhost:3000/traces/<id>                 ← open it NOW
#   └─────────────────────────────────────────────────────┘

# While it streams (or right after): score it and watch chips pop in.
pnpm eval:seed && pnpm eval:run
```

## Evaluation engine

Cost and latency tell you what your AI *did*; evals tell you whether it was any
**good**: and whether your last prompt/model change made it better or worse. An
eval **reads spans that already landed**, scores them out-of-band, and writes the
result back in OpenTelemetry's `gen_ai.evaluation.result` shape. The runner never
touches the collector's ingest path, so evaluation load can't slow ingestion.

### The two evaluator types

- **Deterministic** (no model call, no cost): config-driven rules over a span's
  input or output, `valid_json`, `json_schema` (JSON-Schema via ajv),
  `regex_match` / `regex_no_match`, `contains` / `not_contains`, `max_length`. The
  score is the fraction of rules that pass; `mode: all | any` decides pass/fail.
- **LLM-as-judge**: give a rubric plus the span's input and output to a judge
  model; it returns a numeric score (normalized to 0–1), pass/fail, and a
  rationale. The judge's own call is **instrumented**, it emits a `gen_ai` span to
  the collector like any other LLM call (TraceBloom dogfoods itself). Judge calls
  are cost-controlled: per-eval sampling, a content-hash cache so identical outputs
  are never re-scored, bounded concurrency, and per-call timeout + retries.

An eval definition (Postgres) has a `type`, a `config` (shape depends on the type),
a **selector** (which spans to score, by service / model / operation, plus a
sampling rate), and a `version` that auto-bumps when the config changes so results
recompute under a fresh key. Results are **idempotent**, keyed by
`(eval_id, eval_version, span_id)`.

### Variant comparison & regression detection

Tag a span with a prompt version to make it a **variant** (otherwise the variant is
the request model):

```ts
import { instrumentOpenAI, setPromptVersion } from '@tracebloom/sdk';

// Per client…
const openai = instrumentOpenAI(new OpenAI(), { promptVersion: 'v2' });
// …or per call, on the active span:
setPromptVersion('v2', 'summarize');
```

The runner computes each variant's mean score and pass rate over a window and flags
a **regression** when a variant drops beyond a configurable threshold versus a
baseline variant (the best-scoring one, or an explicit one). Regressions are
persisted and POSTed to an alerting **webhook stub** (`TRACEBLOOM_EVAL_WEBHOOK_URL`).

### Quickstart: define, run, and view evals

```bash
# Prereq: the stack is up (pnpm stack:up) and Postgres migrations are applied:
DATABASE_URL=postgres://tracebloom:tracebloom@localhost:5432/tracebloom \
  pnpm --filter @tracebloom/db db:migrate

# 1. Seed two sample evals (one deterministic, one LLM-judge).
pnpm eval:seed

# 2. Emit some traces (e.g. pnpm smoke), then score them out-of-band.
#    Set OPENAI_API_KEY to enable the LLM-judge eval; without it, judge evals
#    are skipped and deterministic evals still run.
pnpm eval:run           # score once   (add --watch to run on an interval)

# 3. See scores, variant comparison and regressions in the dashboard.
pnpm --filter @tracebloom/dashboard dev   # → http://localhost:3000/evals
```

## Development

```bash
pnpm lint         # Biome (lint + format check) across all JS/TS
pnpm typecheck    # tsc --noEmit across packages (Turborepo)
pnpm test         # vitest (SDK, eval framework, eval-runner)
pnpm build        # build sdk-ts, eval, db, eval-runner, dashboard
pnpm db:migrate   # apply Postgres migrations (eval definitions, regressions)
pnpm eval:seed    # insert the sample eval definitions
pnpm eval:run     # score landed spans once (add --watch to loop)
pnpm seed:agent   # emit a demo multi-step agent trace for the viewer
pnpm demo:seed    # load the curated demo project (idempotent; demo:reset / demo:verify)
pnpm stack:down   # tear the stack down

# Production stack, locally (same images + compose the demo VM runs):
./infra/prod/deploy.sh up      # build images, migrate, start behind Caddy on :80
./infra/prod/deploy.sh seed    # seed the demo; then ./infra/prod/smoke.sh

# Integration tests against real services are env-gated (otherwise skipped):
# the eval-runner's ClickHouse+Postgres test needs TRACEBLOOM_TEST_CLICKHOUSE_URL
# and DATABASE_URL; the dashboard's trace-query and live-SSE streaming tests
# need TRACEBLOOM_TEST_CLICKHOUSE_URL.

# Collector (Rust)
cargo test                                   # unit tests; integration test runs when
                                             # TRACEBLOOM_TEST_CLICKHOUSE_URL is set
cargo clippy --all-targets -- -D warnings

# Python SDK
cd packages/sdk-py && uv run pytest && uv run mypy && uv run ruff check
# Its SDK→collector→ClickHouse integration test is env-gated too:
# TRACEBLOOM_TEST_COLLECTOR_URL + TRACEBLOOM_TEST_CLICKHOUSE_URL (else skipped)

# Editing model prices? Change pricing/model-prices.json, then re-vendor:
pnpm pricing:sync
```

CI (GitHub Actions) runs lint, type-check, test, and build for every package on
a clean checkout, including the ClickHouse-backed collector integration test, the
eval-runner's ClickHouse+Postgres integration + regression test, the dashboard's
trace-query integration test (seeded trace → spans payload → tree → lazy
content), and the end-to-end smoke test against service containers. A separate
**deploy job** builds the three production images, boots the full production
compose from empty volumes, seeds the demo, verifies the runner-detected
regression, and asserts the public guardrails (database-level read-only,
bounded + rate-limited try-it). An opt-in workflow pushes images to GHCR and
redeploys the demo VM on merge to main (docs/self-hosting.md).

## Roadmap

Milestones 1 (core loop), 2 (evaluation engine), 3 (agent trace viewer),
4 (Python SDK), 5 (live tracing), 6 (public demo, production deploy, curated
seed, read-only public access, try-it sandbox, landing page) and 7 (framework
integrations, LangChain + LangGraph, LlamaIndex, OpenAI Agents SDK, Vercel AI
SDK, all via native hooks) are done. Not built yet:

- **Auth & multi-tenancy** (next productization milestone), real accounts,
  per-project API keys and scoped ingest. The public demo deliberately ships
  as a guarded read-only instance instead of half of an auth system
  (DECISIONS.md D25). **Billing** rides with it. Both were explicitly out of
  scope for M7.
- **More framework integrations**: AutoGen, Haystack, CrewAI, LangChain.js,
  and a compatibility matrix. M7 shipped the dominant four via native hooks
  (D29–D31); these slot into the same registry / telemetry-integration surface.
- **Collector → pub/sub push path** for the live channel, cursor-polled
  deltas today (already sub-second); a collector-side notify would shave the
  remaining latency if it ever matters (D21 documents the trade).
- **Side-by-side trace comparison** (deferred from M3), two traces (e.g. a
  variant-A run vs a variant-B run) rendered as parallel waterfalls, reusing
  the M2 variant concept and the existing viewer components.
- **Offline dataset / regression harness**: run a dataset of inputs through a
  configured model + prompt and score the outputs (a bounded model-call target,
  not arbitrary user code). Deferred from M2; the evaluator framework is designed
  to support it (evaluators are pure `(input, output) → outcome`).
- **Real alerting integrations**: beyond the current webhook stub
  (Slack/PagerDuty/etc.), plus human-annotation queues.
- **Publish the Python SDK to (Test)PyPI** with a release workflow, deferred
  from M4 (needs the PyPI project + trusted-publishing secrets); today it
  installs from the repo.
- **Provider routing & budgets**, **edge deployment**.
- **OTLP/JSON and OTLP/gRPC ingest** (protobuf/HTTP today); **durable write
  retry / dead-lettering** in the collector.

## Project status

TraceBloom is a **showcase project**, published so the design and the code can be
read and run. It is pre-1.0 and not accepting pull requests right now, issues
and questions are welcome. Security reports have their own private channel; see
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).
