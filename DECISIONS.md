# Engineering Decisions

Short log of non-obvious choices. Architectural ground rules (OTel GenAI data
model, content-as-events, ClickHouse + Postgres split, Rust collector, TS/Py
SDKs, Next.js dashboard, monorepo) are project constraints, not decisions, and
are documented in the README.

## D1. OTLP wire format: Protobuf over HTTP (not JSON)

The collector ingests **OTLP/HTTP with Protobuf** (`Content-Type:
application/x-protobuf`). The TS SDK exports via `@opentelemetry/exporter-trace-otlp-proto`.

- Protobuf is the canonical OTLP encoding used by every OTel SDK and the OTel
  Collector, so "we speak real OTLP" stays true on the wire, not just the data model.
- The `opentelemetry-proto` crate ships **pre-generated** Rust, so the collector
  decodes `ExportTraceServiceRequest` with `prost` and needs **no `protoc`** at
  build time, keeps CI and contributor setup simple.
- Binary decode is cheaper than JSON on the hot path.

OTLP/HTTP **JSON** ingest is a roadmap item (useful for browser/edge clients).

## D2. Content captured as span events, off by default

Per the project rule, prompt/response content is never a span attribute. The SDK
emits OTel log-style span **events** (`gen_ai.user.message`,
`gen_ai.assistant.message`, ...) and the collector stores them in a separate
`span_events` table. Capture is gated by `TRACEBLOOM_CAPTURE_CONTENT=1` (SDK
side) and defaults **off** so no PII leaves the app unless explicitly enabled.

## D3. Collector write path: bounded channel → dedicated batch writer

Request handlers decode + convert OTLP into row structs and `try_send` them onto
a **bounded** `tokio::mpsc` channel. A single background task drains the channel
and writes to ClickHouse in batches (size- or time-triggered).

- Decouples request latency from ClickHouse write latency.
- The bounded channel is the backpressure mechanism: when full, ingest returns
  HTTP 429 instead of growing memory unboundedly.
- ClickHouse strongly prefers few large inserts over many small ones; batching is
  a correctness/throughput requirement, not just an optimization.

No `.unwrap()`/`.expect()` on any request path; all fallible ingest steps map to
typed errors and proper HTTP status codes.

## D4. Trace/span IDs stored as lowercase hex strings

ClickHouse columns for `trace_id`/`span_id`/`parent_span_id` are `String`
holding lowercase hex (32 / 16 chars). Rationale: matches how IDs appear in OTLP
JSON and every UI/CLI, makes dashboard filters (`WHERE trace_id = '...'`) and
copy-paste trivial, and avoids `FixedString`/`UUID` conversion friction. The
small storage overhead is acceptable at M1 scope; revisit with `FixedString(16)` +
hex codecs if it ever matters.

## D5. TypeScript 6.0, not 7.0

TS 7.0 (the Go-native "Corsa" compiler) is at RC at project start; 6.0 is the
current stable and is supported by Biome, Next 16.2, and the wider ecosystem. We
pin 6.0 and will move to 7.0 after GA + tool support settles.

## D6. Biome for lint + format

One fast Rust-based tool replaces ESLint + Prettier across all JS/TS packages.
Avoids the ESLint / typescript-eslint ↔ TypeScript-version compatibility matrix
and keeps a single config. `noExplicitAny` is set to error to enforce the
"no `any` without justification" bar.

## D7. ClickHouse client: official `clickhouse` (Rust) and `@clickhouse/client` (JS)

Both are first-party, typed, and speak the HTTP interface with RowBinary/JSON.
The Rust crate's `Row` derive gives compile-time-checked column mapping for the
insert path.

## D8. Eval results align with the OTel `gen_ai.evaluation.result` event

We checked the live OpenTelemetry GenAI evaluation conventions (now in the
[`semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai)
repo). The canonical shape is an **event named `gen_ai.evaluation.result`**,
parented to the evaluated GenAI span (or carrying `gen_ai.response.id` when the
span id isn't available), with attributes `gen_ai.evaluation.name`,
`gen_ai.evaluation.score.value`, `gen_ai.evaluation.score.label`,
`gen_ai.evaluation.explanation`, and `error.type`.

`@tracebloom/eval` treats that event as the source of truth (`toEvaluationResultEvent`
builds it, and it's unit-tested against the spec). ClickHouse's `eval_results`
table is the **queryable materialization** of that event, the same philosophy as
the `spans` table promoting hot `gen_ai.*` fields to typed columns. Documented
deviations: (1) a table rather than raw events, so score distributions aggregate
by eval/model/variant/time without JSON extraction; (2) a convenience `passed`
UInt8 and denormalized `request_model` / `operation_name` / `service_name` /
`prompt_version` / `variant` dimensions copied from the evaluated span; (3) an
errored evaluation stores `score_value = 0` with a non-empty `error_type`, and all
aggregations filter `error_type = ''` so failures never skew a score. Everything
stays vendor-neutral, no proprietary attribute names.

## D9. Idempotency: the ReplacingMergeTree sort key *is* the eval key

`eval_results` is a `ReplacingMergeTree(evaluated_at)` ordered by
`(eval_id, eval_version, span_id)`, exactly the identity of "this eval version's
result for this span." Re-running an eval over the same span collapses to one row
on merge (newest `evaluated_at` wins); reads that must see the collapsed view use
`FINAL`. The runner also does an explicit pre-check (`fetchExistingSpanIds`) so it
skips already-scored spans rather than re-inserting, making re-runs cheap as well
as correct. `eval_version` is bumped in Postgres whenever a definition's config
changes, so edited evals recompute under a fresh key while old results stay
queryable. Sampling is a **deterministic hash of the span id**, not a random roll,
so the sampled subset is stable across runs (idempotent) rather than drifting.

## D10. Cost control for judge calls

Judge calls cost tokens, so four mechanisms cap spend: (1) a per-eval
`samplingRate`; (2) a **content-hash cache**, before scoring, the runner looks up
prior *successful* results (`error_type = ''`) by `hash(eval_version + input +
output)` and reuses them, and within a batch it scores each unique content only
once, so identical outputs are never re-judged; (3) **bounded concurrency** on
judge calls; (4) resilience, each judge call has a timeout and bounded retries
with exponential backoff, and the judge evaluator never throws: on failure it
returns an `error.type` outcome, so a flaky judge degrades gracefully instead of
crashing the runner.

## D11. The eval runner is a TypeScript worker, out-of-band from ingestion

Built in TypeScript (not Python) so it shares the repo's types and clients: the
`gen_ai` attribute keys, the cost/pricing map, the ClickHouse client, and (key
for dogfooding) the SDK's `instrumentOpenAI`, which wraps the judge client so the
tool's own judge calls emit `gen_ai` spans to the collector like any traced call
(the runner's judge service is excluded from evaluation to avoid self-scoring).
The runner only ever **reads** spans that have already landed and writes to a
separate table on an interval / on demand; it never touches the collector's
ingestion hot path, so evaluation load can never slow or block ingest.

## D12. Variant derived at read time; no collector change

A *variant* is `gen_ai.prompt.version` when the span is tagged, else
`gen_ai.request.model`. The SDK tags `gen_ai.prompt.version` (a real OTel
attribute); the collector already stores unpromoted attributes losslessly in
`attributes_json`, so the runner extracts the prompt version with
`JSONExtractString` and denormalizes it onto `eval_results`. This keeps the
variant dimension working **without changing the collector or the ingestion hot
path**: the promotion happens out-of-band in the runner.

## D13. Trace viewer data path: one flat query per table, tree built client-side

`/traces/:id` issues exactly **one ClickHouse query for all spans of the trace**
(bloom-filter indexed on `trace_id`, `LIMIT 1 BY span_id` to collapse
collector-retry duplicates, a 10k-span cap with a `truncated` flag) plus **one
parallel query** against `eval_results` (`FINAL`, latest `eval_version` per
eval × span). No per-span round trips, no joins on the hot path. The payload is
deliberately **lean**: promoted columns only, `attributes_json` never ships
with a whole trace; tool name / prompt version / retry attempt are
`JSONExtract`ed in the query per the D12 pattern, so the collector and schema
are untouched. Tree **reconstruction happens client-side** (`lib/trace-tree`,
pure + unit-tested) from the flat rows: dedupe → parent resolution (missing
parents become flagged *orphaned roots*) → deterministic cycle cutting →
children ordered by `(start offset, span id)` → subtree roll-ups in one reverse
pre-order pass. Shipping flat rows keeps the JSON small and lets
expand/collapse re-derive visible rows without re-fetching. One subtlety:
absolute unix **nanoseconds exceed 2^53**, so the server converts them with
BigInt and only offsets-from-trace-start cross into JS numbers.

## D14. Span content is lazy-loaded, one span at a time

Prompt/response content lives in `span_events` (D2) and is fetched **only when
a span is opened**, via `GET /api/traces/:id/spans/:spanId` (one span row with
full attributes + that span's events; capped, deduplicated). The trace payload
never includes content, so opening a 1,000-span trace moves kilobytes, not the
transcript of every call, and content stays out of the page unless a human
asks for exactly one span's worth. Content capture is off by default (D2);
when a span has no content events the panel says so and points at
`TRACEBLOOM_CAPTURE_CONTENT=1` rather than rendering an empty box. Eval scores
+ judge rationale are *not* lazy: they ride the cheap trace-level
`eval_results` query, because chips must be visible on rows before any click.

## D15. Waterfall + tree rendered with CSS grid divs; hand-rolled virtualization

No charting or virtualization dependency. Each row is one CSS grid (shared
column template with the header, so tree and timeline stay aligned); the bar is
a positioned div with `left`/`width` in percent of trace duration (3px
min-width so instant spans stay visible), quartile hairlines + a time axis
above. Span kinds use the validated categorical palette (llm=blue, tool=aqua,
agent=yellow; generic is deliberately neutral gray) **paired with per-category
icons** so identity is never color-alone; errors use the reserved status red
with a text badge. Virtualization is ~40 lines of fixed-row-height windowing
(scrollTop arithmetic over a spacer div, 12-row overscan, rAF-coalesced scroll
state): rows are fixed-height and already flattened to an array, which is the
exact case where a library adds nothing. jsdom reports `clientHeight` 0, so
the window falls back to a real viewport height, the rendering smoke tests
exercise the same windowed path browsers use.

## D16. Python SDK: official OTel instrumentation + one enrichment stage at the edge

The Python SDK does **not** hand-roll provider patching (unlike the TS SDK's
deliberate structural wrapper). `init()` applies the OpenTelemetry
instrumentations, `opentelemetry-instrumentation-openai-v2` **2.4b0** (the
official contrib GenAI instrumentation; beta because the GenAI semconv itself
is experimental) and `opentelemetry-instrumentation-anthropic` **0.62**
(contrib `instrumentation-genai` lineage), wired to TraceBloom's own tracer
provider, with `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` so
they emit the current `gen_ai.*` shape. Versions verified on PyPI 2026-07-16.

What upstream emits doesn't match TraceBloom's storage contract, so a single
`TraceBloomSpanProcessor` adapts every span at the edge:

- **on_start**: stamps the contextvar prompt tag (`prompt_version(...)`, the
  Python analogue of `instrumentOpenAI(client, { promptVersion })`, since
  patched library calls can't take extra arguments).
- **on_end**: normalizes legacy keys (`gen_ai.usage.prompt_tokens` →
  `input_tokens`, `gen_ai.system` → `gen_ai.provider.name`), computes
  `tracebloom.cost.*` from usage tokens + the shared pricing map, and converts
  content-bearing span **attributes** (`gen_ai.input/output.messages`, legacy
  indexed `gen_ai.prompt.N.*`) into the D2 span **events** when capture is on
, and strips them unconditionally either way. D2 is enforced by our layer at
  export time; upstream instrumentation is not trusted with it.

Two supporting choices: capture mode is pinned to `span_only` (the
`event_only` mode routes content to a **Logs** pipeline the collector doesn't
ingest, traces-only on the wire, D1), and the on_end rewrite mutates
`ReadableSpan._attributes`/`._events` (the OTel SDK has no sanctioned rewrite
hook; the locked OTel version pins the behavior and tests would catch a
break). Instrumentation failures log-and-skip and missing libraries are a
silent no-op; auto-instrumentation must never crash the host app.

## D17. One canonical pricing file, vendored byte-identical into both SDKs

Token pricing lives in exactly one place: `pricing/model-prices.json`.
`pnpm pricing:sync` copies it verbatim into `sdk-ts/src/pricing-data.json`
(compile-time JSON import) and `sdk-py/src/tracebloom/_pricing.json` (package
data via `importlib.resources`), vendoring, not runtime reads, because each
package must ship self-contained (the Python wheel can't reference repo
paths). Two guards keep it one source of truth: each SDK has a unit test
asserting its vendored copy is **byte-identical** to the canonical file (a
hand-edited fork fails CI), and `pricing/cost-parity-cases.json` pins exact
IEEE-754 expected costs that both SDKs' tests assert with strict equality —
the arithmetic is kept operation-for-operation identical (`(tokens / 1e6) *
per_mtok`, summed), so "identical cost across languages" is a tested
invariant, not an aspiration.

## D18. Eval hook: SDKs emit the canonical event; the runner promotes it

Both SDKs expose one eval hook (`recordEvaluation` / `record_evaluation`)
that attaches the D8 `gen_ai.evaluation.result` event to the active span —
the SDK writes the *canonical wire shape*, nothing proprietary. Ingestion is
untouched: the event lands in `span_events` like any other, and the eval
runner **promotes** it into `eval_results` on each pass (the D12
out-of-band-promotion pattern; no collector change). Promoted rows use
`eval_id = 'sdk:<evaluation name>'` with `eval_version = 1`: SDK feedback
isn't a versioned Postgres definition, and the D9 ReplacingMergeTree key
(eval_id, version, span_id) makes re-promoting overlapping windows idempotent
for free. Convention choices: `evaluator_type = 'sdk'`, `passed = score >=
0.5` when unlabeled (the event has no pass concept), malformed event bodies
are skipped (promotion must tolerate hand-rolled emitters), and a promotion
failure never blocks definition-driven evals.

## D19. Python auto-instrumentation is configurable but on by default

`init(instrument=[...])` defaults to `("openai", "anthropic")`, the headline
is "one line and your calls appear", so the default must instrument.
LangChain support ships behind the same registry (`instrument=[...,
"langchain"]` + the `tracebloom[langchain]` extra, using contrib's
`opentelemetry-instrumentation-langchain`) but is **opt-in**: it patches a
whole framework rather than one client library, and it is not exercised by
our test matrix the way openai/anthropic are (they run against real clients
with mocked transports in CI). `shutdown()` uninstruments whatever was
applied, so init/shutdown cycles (tests, notebooks) don't leak patches.

## D20. Live transport: SSE with the cursor riding the event id

The live channel is **Server-Sent Events**, not WebSockets. The data flow is
strictly server→browser (there is nothing for the client to send after the
subscribe), which is exactly SSE's shape; `EventSource` gives automatic
reconnection with `Last-Event-ID` for free; and a Next.js route handler can
return a streaming `Response` natively, where WebSockets would need a custom
server. Every `delta` message sets its **SSE event id to the encoded cursor**
(`s<spanMs>e<evalMs>`), so the browser's own reconnect machinery *is* the
resume protocol, no bespoke handshake. Fresh subscriptions pass the
server-snapshot cursor as `?cursor=`; a terminal `end` event (trace settled or
dead) tells the client to stop reconnecting, and a non-200 subscribe (e.g.
capacity 503) stops `EventSource` retry loops by spec. Heartbeat comments
every 15s keep proxies from idling the connection out.

## D21. Deltas by cursor-polling ClickHouse; the collector is untouched

The live channel **polls ClickHouse with cursor-bounded delta queries** from
the dashboard process; no Redis/pub-sub was added and the collector required
**zero changes** (its single sequential writer already stamps every row with
`ingested_at DateTime64(3)`, which is the cursor). Rationale: the collector's
hot path stays exactly as fast as before by construction, the only shared
resource is ClickHouse, and the read side is bounded: each poll is one pair
of `WHERE trace_id = X AND ingested_at >= cursor` queries (bloom-filter
indexed, arrival-ordered, row-capped), never a full-trace re-fetch, at an
adaptive cadence (~800ms while running, ~2.5s once the root landed, stop on
quiet). The cursor bound is **inclusive**, millisecond timestamps mean two
batches can share a watermark, so `>` could drop rows; `>=` re-reads the
boundary and the client's merge-by-id makes that idempotent (**no gaps, no
dupes** needs only a *coarse* watermark plus an idempotent apply). The poller
trims already-delivered boundary rows so quiet ticks are genuinely empty.
Tests enforce the isolation: fetch counts are identical for 1/5/25
subscribers, and a source-level guard keeps the live modules read-only and
collector-free. A collector→dashboard push path stays on the roadmap for
shaving the remaining ~1s of latency; it buys nothing else and costs a
coupling, so it lost the tie.

## D22. In-progress spans are synthesized from missing parents

OTel SDKs export a span **when it ends**, so a running span cannot arrive —
but its completed children do, and they carry its id. Live mode therefore
extends M3's orphan handling: a referenced-but-missing parent becomes a
synthesized **pending placeholder node** (zero duration, starts at its
earliest child's start) whose bar grows against a ticking "now"; when the
real span lands it **replaces the placeholder in place**, same span id,
same React key, so the running→complete/error flip is a restyle, not a
remount. The whole trace is "running" until a **root span** (empty parent id)
arrives, roots complete last, with a staleness bound (`RUNNING_STALE_MS`,
10 min without ingest activity) so a crashed agent's trace degrades to the
M3 orphan rendering instead of pulsing forever. Completed traces never
synthesize placeholders: a missing parent there is a data defect (orphan),
not an open span.

## D23. Live fan-out: one poller per trace, bounded everything

A registry holds **one poller per watched trace**; every SSE subscriber of
that trace shares it, so ClickHouse read load scales with *watched traces*,
never with open tabs. Late subscribers get a single catch-up query from
their own cursor and then ride the shared broadcast, attached *before* the
catch-up runs, so the union of catch-up and broadcasts can overlap but never
gap (the client merge dedupes). Bounds and teardown: global and per-trace
subscriber caps (rejected with 503 + Retry-After up front); a slow consumer
(persistently negative stream `desiredSize`) is **dropped, not buffered** —
its auto-reconnect resumes from its cursor, which self-heals the backlog; a
poller ends itself after a settled/dead quiet window, closes (without `end`)
after consecutive ClickHouse failures so clients retry, and stops the moment
its last subscriber detaches, unsubscribe/abort/cancel are idempotent and
the tests assert zero timers remain. The registry lives on `globalThis` so
Next dev-mode HMR can't leak a second set of live timers.

## D24. Deploy topology: one small VM, Caddy is the only public service

The public demo (and the reference self-host path) is a **single VM running
one production Docker Compose stack** (`infra/prod/`): cheap, reproducible,
and one `deploy.sh up` from a bare Ubuntu box, no orchestrator to operate
for what is structurally a single-tenant read-mostly app. **Caddy 2.11** is
the only service that publishes ports (80/443 → dashboard; automatic HTTPS
when `DEMO_DOMAIN` is set, plain :80 otherwise for IP-only VMs and the CI
smoke); the collector, ClickHouse and Postgres publish **nothing**, so no
one outside the compose network can inject spans or reach a database at all.
Secrets are generated into a git-ignored `.env` by `deploy.sh` on first run.
Images build on the VM by default; setting `TRACEBLOOM_IMAGE_PREFIX` flips
the same compose file to pulling CI-built images from GHCR. Two operational
gotchas are encoded in the compose file: the ClickHouse healthcheck probes
the container's **network IP** (the first-boot entrypoint runs a temporary
loopback-only server that would otherwise pass the probe early), and the
Caddy site address is computed by compose (`${DEMO_DOMAIN:-:80}`) because
Caddy's own `{$VAR:default}` fallback does not trigger for empty-but-set
variables.

## D25. Public read-only access is layered, not trusted to app code

"The public path provably cannot write" is enforced three times over:
**network**: only the dashboard is reachable (D24); **credentials**, the
public dashboard connects with a SELECT-only Postgres role
(`tracebloom_ro`, created idempotently by the migrate job) and a
readonly-profile ClickHouse user (readonly=2 + `allow_ddl=0` + execution
limits, password injected via `from_env`), so even a compromised dashboard
process cannot INSERT or ALTER; **application**, `TRACEBLOOM_PUBLIC_DEMO=1`
makes every mutating server action refuse up front and renders the eval
config UI read-only. There is deliberately **no admin HTTP surface**: seed,
reset and eval-config changes happen via SSH + `docker compose run`, which
removes authentication from this milestone's threat model entirely (full
multi-tenant auth is roadmapped, not half-shipped). CI asserts the
credential layer directly by attempting INSERTs with the dashboard's users.

## D26. Demo seed: generated corpus with real evaluator scores, real regression detection

The curated demo must show a week of "production" traffic with an A/B
regression on first load, something a live agent cannot produce at seed
time. The seed therefore **writes the historical corpus directly to
ClickHouse**, but keeps every possible layer real: row shapes byte-match the
SDK→collector pipeline (same span names, kinds, `gen_ai.*` attributes,
content events, cost math, the dashboard cannot tell them apart);
`no-refusal` scores are computed by the **real `DeterministicEvaluator`**
over the seeded content; v2's refusal rate is fixed **by count** so its
pass rate provably drops past the runner's threshold in the 24h window, and
the **real regression detector** (watch-mode runner) flags v2 organically —
the banner is never inserted. Judge (`answer-quality`) scores + rationales
are the one seeded fiction, because the demo runs with **no API key
anywhere**. One fresh "hero" trace goes through the actual SDK → collector
at seed time. Everything is namespaced by `service_name`
(`demo-researcher` / `demo-sandbox`), which is what makes reset a targeted
delete + reseed (timestamps are relative to *now*, so a reset also
re-anchors the demo) and sandbox traffic separable from the curated story.
Seeding is idempotent by presence check; `verify` is the CI contract.

## D27. Try-it sandbox: mock-only, in-process, bounded by construction

The public "run a live agent" button executes a **canned researcher agent in
the dashboard process with the real TS SDK**, exporting OTLP to the internal
collector, the run is real telemetry through the real pipeline, rendered by
the untouched M5 stream. **M7 makes it a real framework agent:** a genuine
Vercel AI SDK `generateText` tool loop captured by `createAISDKTelemetry`
(D31), so the demo shows an actual framework run, not a hand-rolled script —
the AI SDK integration builds its spans with the `@tracebloom/sdk` tracer, so
they keep the allowed scope and the D28 ScopeFilter still drops everything
foreign. Mock LLM **only**: no provider key exists in the dashboard process,
so prompt-injection and spend risk are structural zeros, not rate-limited
maybes (the env layout keeps a server-side-only slot if a real provider is
ever wanted). The model is scripted and no user input reaches the run, so
spans (9) and duration (~15s) are bounded by construction; enforcement on top:
an `AbortSignal` watchdog, a global concurrency cap and daily run budget in
the sandbox, and a per-IP token bucket in the route (429/503 + Retry-After).
We chose in-process over a child process/container because the thing being
bounded is **our own canned agent**, not untrusted code, OTel context
isolation already separates concurrent runs, and a process boundary would only
add image plumbing. The scripted search fails once then succeeds (the errored
span and its retry sit side by side) and the draft deliberately refuses ("I
cannot …"), tagged variant `sandbox` (kept out of the v1/v2 A/B), so the eval
runner pins a red `no-refusal` chip onto the span while the visitor watches.

## D28. A registered tracer provider wakes Next.js: export only SDK-scoped spans

Calling the SDK's `init()` inside the dashboard registers a global OTel
tracer provider, which **activates Next.js's built-in instrumentation**:
every HTTP request suddenly produces `POST /api/...` spans, flooding the
demo with noise and feeding the live-SSE route's own polling back into the
traces it serves; the sandbox run also inherited the request's context and
nested under Next's request span instead of being a trace root. Two
structural fixes, both tested: the sandbox run executes under
`context.with(ROOT_CONTEXT, ...)` so the agent is its own root, and a
`ScopeFilterSpanProcessor` forwards **only spans whose instrumentation scope
is `@tracebloom/sdk`** to the exporter; foreign scopes (`next.js`) are
dropped before they leave the process. The CI smoke asserts a sandbox trace
contains zero non-`gen_ai` spans.

## D29. Framework capture rides native hooks, never monkey-patched internals

Every M7 framework integration is an **existing OpenTelemetry-ecosystem
instrumentor built on the framework's own hook**, not hand-rolled patching of
framework internals, and each plugs into the same `init(instrument=[...])`
registry the provider libraries use (opt-in, since a framework captures a
whole stack, not one client, D19). Versions verified on PyPI/npm 2026-07-20:

- **LangChain + LangGraph**: `opentelemetry-instrumentation-langchain`
  **0.62.1** (Traceloop), which registers a LangChain **callback handler** and
  wraps `Pregel.stream`/`astream`. `langchain` and `langgraph` are separate
  registry names gating on their own library but sharing one instrumentor
  (applying it twice is a no-op). It already emits near-canonical `gen_ai.*`
  (invoke_agent / execute_task / execute_tool / chat), so our processor only
  enforces the storage contract on it. Two upstream bugs are worked around and
  pinned by tests: its `_uninstrument` passes `"Class.method"` strings to
  OTel's `unwrap()` (a silent no-op that leaks wrappers and blocks the next
  `init()`'s handler by type-dedupe), `shutdown()` force-unwraps the sites;
  and custom/wrapped chat models surface as request model `"unknown"` while the
  langsmith `ls_model_name` rides an association property, the enrichment
  stage promotes it so cost still computes.
- **LlamaIndex**: `openinference-instrumentation-llama-index` **4.4.3**
  (Arize), on LlamaIndex's native instrumentation dispatcher.
- **OpenAI Agents SDK**: `openinference-instrumentation-openai-agents`
  **1.6.1** (Arize), on the SDK's native `set_trace_processors` hook.
- **Vercel AI SDK**: our own `createAISDKTelemetry` on the AI SDK's native
  `registerTelemetry` (D31); no third-party package.

No hand-rolled monkey-patching was needed anywhere: every framework exposed a
callback / telemetry / trace-processor hook. Missing libraries are a silent
no-op; instrumentation never crashes the host app.

## D30. OpenInference spans are rewritten to gen_ai at the edge, once

The two Arize instrumentors (LlamaIndex, OpenAI Agents) emit the
**OpenInference** conventions (`openinference.span.kind`, `llm.token_count.*`,
indexed `llm.input_messages.N.*`), not `gen_ai.*`. Rather than teach the
collector or viewer a second vocabulary, a single pure mapping
(`sdk-py/_openinference.py`) rewrites each span **in place** in the enrichment
processor to the exact canonical shape every other path emits, LLM→`chat`,
TOOL→`execute_tool`, AGENT (and workflow-agent CHAIN roots like
`ReActAgent.run`)→`invoke_agent`, RETRIEVER/CHAIN→`execute_task`,
EMBEDDING→`embeddings`, promoting model/usage/params to `gen_ai.*` keys,
renaming the span to `chat <model>` / `execute_tool <name>`, routing content
through the D2 event rule, and stripping every `openinference.*`/`llm.*`/etc.
key before export. It is a pure `(name, attrs) -> content` function so both
OpenInference integrations reuse it verbatim and it is unit-testable without a
framework. This keeps "one span vocabulary" a property enforced at exactly one
place, the same edge that already normalizes the OpenAI/Anthropic paths (D16).

## D31. Vercel AI SDK: build spans from the native telemetry hook, not its OTel spans

The AI SDK ships two telemetry surfaces: (a) built-in OTel span emission
(`experimental_telemetry`), and (b) a first-class **integration hook** —
`registerTelemetry()` / per-call `telemetry.integrations`, that delivers
lifecycle events (operation, per-step, each model call, each tool execution)
plus `executeLanguageModelCall`/`executeTool` context wrappers.
`createAISDKTelemetry` builds gen_ai spans from **(b)**, not (a): the AI SDK's
own spans carry content as attributes (violating D2) and a shape we'd have to
re-map, whereas the hook lets us own the span shape directly and reuse the
`execute*` wrappers to nest a tool's inner `generateText` (agent-as-tool) as a
real sub-agent. The run maps to `invoke_agent` (named by `functionId`) →
`execute_task` per step → `chat` + `execute_tool`, with cost from the shared
pricing map and content as events. Like `openai.ts`, it depends only on a
**structural** type of the telemetry surface, never the `ai` package, so the
SDK stays light and it is a silent no-op unless wired in; the event params are
typed as `unknown` supertypes so the object stays assignable to the AI SDK's
own richer `Telemetry` type.
