//! HTTP surface: the OTLP/HTTP traces endpoint and a health check.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use prost::Message;

use crate::error::IngestError;
use crate::otlp;
use crate::storage::{EnqueueError, Ingestor};

/// Shared application state handed to every request.
#[derive(Clone)]
pub struct AppState {
    pub ingestor: Ingestor,
}

/// Build the collector's router. `max_body_bytes` caps OTLP request size;
/// oversized requests are rejected with 413 before reaching the handler.
pub fn build_router(state: AppState, max_body_bytes: usize) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/traces", post(ingest_traces))
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// Liveness probe. Always 200 while the process is up; readiness against
/// ClickHouse is intentionally separate (the collector buffers through brief
/// ClickHouse blips).
async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// OTLP/HTTP `POST /v1/traces`. Accepts protobuf-encoded
/// `ExportTraceServiceRequest`, converts to rows, and enqueues them.
async fn ingest_traces(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, IngestError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.contains("application/x-protobuf") {
        return Err(IngestError::UnsupportedContentType);
    }

    let request = ExportTraceServiceRequest::decode(body)?;
    let converted = otlp::convert(request);

    if !converted.is_empty() {
        match state.ingestor.enqueue(converted) {
            Ok(()) => {}
            Err(EnqueueError::Full) => return Err(IngestError::Backpressure),
            Err(EnqueueError::Closed) => return Err(IngestError::Unavailable),
        }
    }

    // An empty ExportTraceServiceResponse means "full success" in OTLP.
    let response = ExportTraceServiceResponse::default();
    Ok((
        [(header::CONTENT_TYPE, "application/x-protobuf")],
        response.encode_to_vec(),
    ))
}
