//! Typed ingest errors. Every fallible step on the request path maps to one of
//! these and then to an appropriate HTTP status: there is no `unwrap`/`expect`
//! or swallowed error on the hot path.

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("unsupported content-type: expected application/x-protobuf")]
    UnsupportedContentType,

    #[error("failed to decode OTLP protobuf: {0}")]
    Decode(#[from] prost::DecodeError),

    /// The writer's bounded queue is full: this is backpressure, not a bug. OTLP
    /// clients treat 429 as retryable and back off.
    #[error("ingest queue is full")]
    Backpressure,

    /// The writer task is gone (shutting down or crashed).
    #[error("ingest pipeline unavailable")]
    Unavailable,
}

impl IntoResponse for IngestError {
    fn into_response(self) -> Response {
        let status = match self {
            IngestError::UnsupportedContentType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            IngestError::Decode(_) => StatusCode::BAD_REQUEST,
            IngestError::Backpressure => StatusCode::TOO_MANY_REQUESTS,
            IngestError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };

        // Log server-side faults; client faults (4xx) stay quiet to avoid log spam.
        if status.is_server_error() {
            tracing::error!(error = %self, "ingest failed");
        } else {
            tracing::debug!(error = %self, "ingest rejected");
        }

        if matches!(self, IngestError::Backpressure) {
            return (status, [(header::RETRY_AFTER, "1")], self.to_string()).into_response();
        }

        (status, self.to_string()).into_response()
    }
}
