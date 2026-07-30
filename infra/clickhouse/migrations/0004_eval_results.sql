-- One row per evaluation result. This is the queryable materialization of the
-- OpenTelemetry `gen_ai.evaluation.result` event (see DECISIONS.md D8): the event's
-- attributes (gen_ai.evaluation.name / score.value / score.label / explanation and
-- error.type) are promoted to typed columns, exactly like `spans` promotes hot
-- gen_ai.* fields. A handful of dimensions from the evaluated span (model, operation,
-- service, prompt.version / variant) are denormalized so score distributions can be
-- aggregated by eval / model / variant / time without joining back to `spans`.
--
-- Idempotency (DECISIONS.md D9): the sorting key (eval_id, eval_version, span_id) IS
-- the idempotency key. ReplacingMergeTree collapses re-runs of the same eval version
-- over the same span to a single row (keeping the newest by `evaluated_at`), so the
-- runner is safe to retry. Aggregations read with FINAL to see the collapsed view.
CREATE TABLE IF NOT EXISTS tracebloom.eval_results
(
    -- Idempotency key + linkage back to the evaluated span/trace.
    eval_id           String,
    eval_version      UInt32,
    trace_id          String,
    span_id           String,
    response_id       String,                  -- gen_ai.response.id (link when span id is unavailable)

    -- OTel `gen_ai.evaluation.result` event attributes, promoted to typed columns.
    evaluation_name   LowCardinality(String),  -- gen_ai.evaluation.name
    score_value       Float64,                 -- gen_ai.evaluation.score.value (normalized 0..1)
    score_label       LowCardinality(String),  -- gen_ai.evaluation.score.label (e.g. pass / fail / relevant)
    passed            UInt8,                    -- tracebloom convenience flag (0/1), derived from the evaluator
    explanation       String,                  -- gen_ai.evaluation.explanation (judge rationale)
    error_type        LowCardinality(String),  -- error.type ('' when the evaluation succeeded)

    -- Denormalized dimensions copied from the evaluated span for fast aggregation.
    evaluator_type    LowCardinality(String),  -- deterministic | llm_judge
    request_model     LowCardinality(String),  -- gen_ai.request.model
    operation_name    LowCardinality(String),  -- gen_ai.operation.name
    service_name      LowCardinality(String),
    prompt_version    LowCardinality(String),  -- gen_ai.prompt.version ('' if the span was not tagged)
    variant           LowCardinality(String),  -- prompt_version when present, else request_model
    content_hash      String,                  -- hash(eval_version + input + output); powers the re-score cache

    -- Time axis is the evaluated span's start time, so scores line up with traffic.
    span_start_time   DateTime64(9, 'UTC'),
    evaluated_at      DateTime64(3, 'UTC') DEFAULT now64(3),

    -- Lossless overflow for evaluator-specific metadata (JSON object string).
    metadata_json     String,

    INDEX idx_eval_id  eval_id  TYPE set(128) GRANULARITY 1,
    INDEX idx_variant  variant  TYPE set(128) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(evaluated_at)
PARTITION BY toDate(span_start_time)
ORDER BY (eval_id, eval_version, span_id)
TTL toDateTime(span_start_time) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
