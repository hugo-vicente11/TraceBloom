//! Runtime configuration, sourced entirely from the environment so the same
//! binary runs unchanged locally, self-hosted, or at the edge.

use std::time::Duration;

/// Collector configuration. Construct with [`Config::from_env`].
#[derive(Debug, Clone)]
pub struct Config {
    /// Address the OTLP/HTTP server binds to (default `0.0.0.0:4318`).
    pub bind_addr: String,
    /// ClickHouse HTTP endpoint (default `http://localhost:8123`).
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    /// Flush the in-memory batch once it reaches this many span rows.
    pub batch_max_rows: usize,
    /// Flush the in-memory batch at least this often, even if not full.
    pub batch_flush_interval: Duration,
    /// Capacity of the bounded ingest->writer channel. This is the backpressure
    /// bound: when full, ingest responds 429 instead of growing memory.
    pub channel_capacity: usize,
    /// Maximum accepted OTLP request body size, in bytes.
    pub max_body_bytes: usize,
}

impl Config {
    /// Build configuration from environment variables, falling back to
    /// development-friendly defaults for anything unset.
    pub fn from_env() -> Self {
        Self {
            bind_addr: env_or("TRACEBLOOM_BIND_ADDR", "0.0.0.0:4318"),
            clickhouse_url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_database: env_or("CLICKHOUSE_DATABASE", "tracebloom"),
            clickhouse_user: env_or("CLICKHOUSE_USER", "default"),
            clickhouse_password: env_or("CLICKHOUSE_PASSWORD", ""),
            batch_max_rows: env_parse("TRACEBLOOM_BATCH_MAX_ROWS", 1000),
            batch_flush_interval: Duration::from_millis(env_parse(
                "TRACEBLOOM_BATCH_FLUSH_MS",
                1000,
            )),
            channel_capacity: env_parse("TRACEBLOOM_CHANNEL_CAPACITY", 1024),
            max_body_bytes: env_parse("TRACEBLOOM_MAX_BODY_BYTES", 4 * 1024 * 1024),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_env()
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    match std::env::var(key) {
        Ok(v) => v.parse().unwrap_or(default),
        Err(_) => default,
    }
}
