-- One row per OTel span. Hot gen_ai fields are promoted to typed columns so the
-- dashboard's common queries (filter by trace / model / time range, aggregate
-- tokens, cost and latency) hit the primary index or a skip index; everything
-- else is retained losslessly as JSON. Prompt/response CONTENT never lands here
-- (PII isolation) -- it goes to span_events. See DECISIONS.md D2/D4.
CREATE TABLE IF NOT EXISTS tracebloom.spans
(
    trace_id            String,
    span_id             String,
    parent_span_id      String,

    name                String,
    kind                LowCardinality(String),
    start_time          DateTime64(9, 'UTC'),
    end_time            DateTime64(9, 'UTC'),
    -- Precomputed so latency aggregations never recompute end-start per row.
    duration_ns         UInt64,
    status_code         LowCardinality(String),
    status_message      String,

    service_name        LowCardinality(String),
    scope_name          LowCardinality(String),

    -- gen_ai.* promoted columns
    operation_name      LowCardinality(String),  -- gen_ai.operation.name (chat, embeddings, ...)
    provider            LowCardinality(String),  -- gen_ai.provider.name / gen_ai.system
    request_model       LowCardinality(String),  -- gen_ai.request.model
    response_model      LowCardinality(String),  -- gen_ai.response.model
    input_tokens        UInt32,                  -- gen_ai.usage.input_tokens
    output_tokens       UInt32,                  -- gen_ai.usage.output_tokens
    total_tokens        UInt32,
    cost_usd            Float64,                 -- tracebloom.cost.total_usd (computed by SDK)
    response_id         String,                  -- gen_ai.response.id
    finish_reasons      Array(String),           -- gen_ai.response.finish_reasons

    -- Lossless overflow for any other attributes (JSON object strings).
    attributes_json     String,
    resource_attributes_json String,

    ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3),

    -- trace_id is not the leading primary-key column, so a bloom filter keeps
    -- single-trace drill-downs cheap without scanning every part.
    INDEX idx_trace_id  trace_id     TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_provider  provider     TYPE set(64)            GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(start_time)
ORDER BY (start_time, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192
