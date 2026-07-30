//! ClickHouse row types. Field order and types mirror the migrations in
//! `infra/clickhouse/migrations`; the `clickhouse::Row` derive maps them by name
//! via RowBinaryWithNamesAndTypes (so `ingested_at`, which has a DEFAULT, is
//! intentionally omitted and filled server-side).

use clickhouse::Row;
use serde::Serialize;
use time::OffsetDateTime;

/// A single span destined for the `tracebloom.spans` table.
#[derive(Debug, Clone, PartialEq, Serialize, Row)]
pub struct SpanRow {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,

    pub name: String,
    pub kind: String,
    #[serde(with = "clickhouse::serde::time::datetime64::nanos")]
    pub start_time: OffsetDateTime,
    #[serde(with = "clickhouse::serde::time::datetime64::nanos")]
    pub end_time: OffsetDateTime,
    pub duration_ns: u64,
    pub status_code: String,
    pub status_message: String,

    pub service_name: String,
    pub scope_name: String,

    pub operation_name: String,
    pub provider: String,
    pub request_model: String,
    pub response_model: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
    pub cost_usd: f64,
    pub response_id: String,
    pub finish_reasons: Vec<String>,

    pub attributes_json: String,
    pub resource_attributes_json: String,
}

/// A single span event destined for the `tracebloom.span_events` table. This is
/// where prompt/response content lives (see DECISIONS.md D2).
#[derive(Debug, Clone, PartialEq, Serialize, Row)]
pub struct SpanEventRow {
    pub trace_id: String,
    pub span_id: String,
    pub event_index: u32,
    pub name: String,
    #[serde(with = "clickhouse::serde::time::datetime64::nanos")]
    pub timestamp: OffsetDateTime,
    pub body: String,
    pub attributes_json: String,
}

/// Result of decoding one OTLP export request: the spans and their events,
/// ready to hand to the writer.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Converted {
    pub spans: Vec<SpanRow>,
    pub events: Vec<SpanEventRow>,
}

impl Converted {
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty() && self.events.is_empty()
    }
}
