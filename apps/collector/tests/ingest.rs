//! End-to-end ingest test: POST a real OTLP/protobuf request to the running
//! server and assert the span (and its content event) land in ClickHouse with
//! the gen_ai fields correctly promoted to typed columns.
//!
//! Skipped unless `TRACEBLOOM_TEST_CLICKHOUSE_URL` (or `CLICKHOUSE_URL`) points
//! at a reachable ClickHouse, so `cargo test` stays green on a machine without
//! a database. CI sets the variable, applies migrations, and runs it for real.

use std::time::Duration;

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value::Value};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{
    ResourceSpans, ScopeSpans, Span, Status, span::Event, span::SpanKind, status::StatusCode,
};
use prost::Message;
use serde::Deserialize;

use tracebloom_collector::config::Config;
use tracebloom_collector::routes::{AppState, build_router};
use tracebloom_collector::storage;

#[derive(Deserialize, clickhouse::Row)]
struct Count {
    c: u64,
}

#[derive(Deserialize, clickhouse::Row)]
struct SpanFields {
    request_model: String,
    provider: String,
    total_tokens: u32,
    cost_usd: f64,
    status_code: String,
}

fn kv(key: &str, value: Value) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue { value: Some(value) }),
        ..Default::default()
    }
}

fn sample_request(trace_id: [u8; 16], span_id: [u8; 8]) -> ExportTraceServiceRequest {
    // Use current time so rows don't fall under the 30-day TTL and get dropped.
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let span = Span {
        trace_id: trace_id.to_vec(),
        span_id: span_id.to_vec(),
        name: "chat gpt-4o".to_owned(),
        kind: SpanKind::Client as i32,
        start_time_unix_nano: now_ns,
        end_time_unix_nano: now_ns + 2_500_000,
        status: Some(Status {
            code: StatusCode::Ok as i32,
            message: String::new(),
        }),
        attributes: vec![
            kv("gen_ai.operation.name", Value::StringValue("chat".into())),
            kv("gen_ai.provider.name", Value::StringValue("openai".into())),
            kv("gen_ai.request.model", Value::StringValue("gpt-4o".into())),
            kv("gen_ai.usage.input_tokens", Value::IntValue(60)),
            kv("gen_ai.usage.output_tokens", Value::IntValue(40)),
            kv("tracebloom.cost.total_usd", Value::DoubleValue(0.0005)),
        ],
        events: vec![Event {
            time_unix_nano: now_ns + 1_000_000,
            name: "gen_ai.user.message".to_owned(),
            attributes: vec![kv("content", Value::StringValue("hello".into()))],
            ..Default::default()
        }],
        ..Default::default()
    };

    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![kv("service.name", Value::StringValue("it-demo".into()))],
                ..Default::default()
            }),
            scope_spans: vec![ScopeSpans {
                spans: vec![span],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

async fn apply_migrations(url: &str) {
    // No database set: the first migration is `CREATE DATABASE`.
    let client = clickhouse::Client::default().with_url(url);
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../infra/clickhouse/migrations"
    );

    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("read migrations dir")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort();

    for file in files {
        let sql = std::fs::read_to_string(&file).expect("read migration");
        client
            .query(&sql)
            .execute()
            .await
            .unwrap_or_else(|e| panic!("migration {} failed: {e}", file.display()));
    }
}

#[tokio::test]
async fn ingest_writes_span_and_event_to_clickhouse() {
    let Some(url) = std::env::var("TRACEBLOOM_TEST_CLICKHOUSE_URL")
        .ok()
        .or_else(|| std::env::var("CLICKHOUSE_URL").ok())
    else {
        eprintln!(
            "skipping: set TRACEBLOOM_TEST_CLICKHOUSE_URL (or CLICKHOUSE_URL) to run the \
             ClickHouse integration test"
        );
        return;
    };

    apply_migrations(&url).await;

    let mut config = Config::from_env();
    config.clickhouse_url = url.clone();
    config.clickhouse_database = "tracebloom".to_owned();
    config.batch_max_rows = 1; // flush each batch immediately
    config.batch_flush_interval = Duration::from_millis(50);

    let client = storage::build_client(&config);
    let (ingestor, _writer) = storage::spawn_writer(client, &config);
    let app = build_router(AppState { ingestor }, config.max_body_bytes);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // Unique IDs per run so reruns don't collide.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let trace_id = nanos.to_be_bytes();
    let span_id = (nanos as u64).to_be_bytes();
    let hex_id = hex::encode(trace_id);

    let body = sample_request(trace_id, span_id).encode_to_vec();
    let response = reqwest::Client::new()
        .post(format!("http://{addr}/v1/traces"))
        .header("content-type", "application/x-protobuf")
        .body(body)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "ingest returned {}",
        response.status()
    );

    let query_client = storage::build_client(&config);

    // Poll for the asynchronously-written row.
    let mut span_count = 0u64;
    for _ in 0..50 {
        span_count = query_client
            .query("SELECT count() AS c FROM tracebloom.spans WHERE trace_id = ?")
            .bind(hex_id.as_str())
            .fetch_one::<Count>()
            .await
            .unwrap()
            .c;
        if span_count > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(span_count, 1, "expected one span row for trace {hex_id}");

    let fields = query_client
        .query(
            "SELECT request_model, provider, total_tokens, cost_usd, status_code \
             FROM tracebloom.spans WHERE trace_id = ?",
        )
        .bind(hex_id.as_str())
        .fetch_one::<SpanFields>()
        .await
        .unwrap();
    assert_eq!(fields.request_model, "gpt-4o");
    assert_eq!(fields.provider, "openai");
    assert_eq!(fields.total_tokens, 100);
    assert!((fields.cost_usd - 0.0005).abs() < 1e-9);
    assert_eq!(fields.status_code, "OK");

    // Content was captured as a span event, not a span attribute. The writer
    // flushes spans and span_events as two sequential inserts (see
    // storage::flush), so the spans row can become visible slightly before the
    // span_events row does; poll here too rather than asserting on a single read.
    let mut event_count = 0u64;
    for _ in 0..50 {
        event_count = query_client
            .query("SELECT count() AS c FROM tracebloom.span_events WHERE trace_id = ?")
            .bind(hex_id.as_str())
            .fetch_one::<Count>()
            .await
            .unwrap()
            .c;
        if event_count > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(event_count, 1, "expected one span_event row");
}
