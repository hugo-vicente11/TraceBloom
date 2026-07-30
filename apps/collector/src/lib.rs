//! TraceBloom collector library.
//!
//! Split into a library + thin binary so the ingest path can be exercised by
//! both unit tests (the pure [`otlp`] conversion) and an integration test that
//! drives the real HTTP server against a ClickHouse instance.

pub mod config;
pub mod error;
pub mod health;
pub mod model;
pub mod otlp;
pub mod routes;
pub mod storage;

use std::net::SocketAddr;

use tokio::net::TcpListener;

use crate::config::Config;
use crate::routes::{AppState, build_router};

/// Initialize tracing/log output from `RUST_LOG` (defaults to `info`). Safe to
/// call more than once (e.g. from tests).
pub fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}

/// Run the collector until a shutdown signal (SIGINT/SIGTERM) is received,
/// flushing buffered rows on the way out.
pub async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let client = storage::build_client(&config);

    // Best-effort connectivity check. We still start if ClickHouse is briefly
    // unavailable so the collector can boot alongside it (compose, k8s, ...).
    match client.query("SELECT 1").execute().await {
        Ok(()) => tracing::info!(url = %config.clickhouse_url, "connected to ClickHouse"),
        Err(err) => {
            tracing::warn!(error = %err, "ClickHouse not reachable yet; will retry on write")
        }
    }

    let (ingestor, writer) = storage::spawn_writer(client, &config);
    let app = build_router(AppState { ingestor }, config.max_body_bytes);

    let listener = TcpListener::bind(&config.bind_addr).await?;
    let addr: SocketAddr = listener.local_addr()?;
    tracing::info!(%addr, "TraceBloom collector listening (OTLP/HTTP at POST /v1/traces)");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // `axum::serve` has returned and dropped the router (and its ingest sender)
    // after waiting for in-flight requests, so the writer now observes a closed
    // channel, drains its buffers, and exits.
    writer.await?;
    tracing::info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal;

    let ctrl_c = async {
        if let Err(err) = signal::ctrl_c().await {
            tracing::error!(error = %err, "failed to listen for ctrl-c");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(err) => tracing::error!(error = %err, "failed to install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
