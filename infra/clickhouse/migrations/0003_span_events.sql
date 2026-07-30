-- One row per OTel span event. This is where prompt/response CONTENT lives
-- (gen_ai.user.message, gen_ai.assistant.message, gen_ai.choice, ...) as well as
-- exceptions. Kept in a separate table so content is never indexed alongside
-- span attributes and can be dropped / TTL'd independently. Ordered by
-- (trace_id, span_id, event_index) for fast per-span / per-trace reconstruction.
CREATE TABLE IF NOT EXISTS tracebloom.span_events
(
    trace_id        String,
    span_id         String,
    event_index     UInt32,
    name            LowCardinality(String),
    timestamp       DateTime64(9, 'UTC'),
    -- JSON-encoded event body (e.g. message content). Free-form; may be large.
    body            String,
    attributes_json String,
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (trace_id, span_id, event_index)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192
