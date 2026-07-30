//! ClickHouse write path.
//!
//! Request handlers do the cheap work (decode + convert) and hand rows to a
//! bounded channel; a single background task batches them and writes to
//! ClickHouse. This decouples request latency from DB latency, keeps inserts
//! large (ClickHouse strongly prefers few big inserts), and makes the bounded
//! channel the backpressure mechanism. See DECISIONS.md D3.

use std::time::Duration;

use clickhouse::Client;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::config::Config;
use crate::model::{Converted, SpanEventRow, SpanRow};

/// Cheaply-cloneable handle used by request handlers to enqueue decoded rows.
#[derive(Clone)]
pub struct Ingestor {
    tx: mpsc::Sender<Converted>,
}

/// Why an enqueue was rejected. Both map to retryable HTTP responses.
pub enum EnqueueError {
    /// The bounded queue is full (backpressure).
    Full,
    /// The writer task has shut down.
    Closed,
}

impl Ingestor {
    /// Enqueue a decoded batch without blocking the async runtime. Returns
    /// immediately with [`EnqueueError::Full`] when the queue is saturated so
    /// the caller can shed load rather than buffer unboundedly.
    pub fn enqueue(&self, batch: Converted) -> Result<(), EnqueueError> {
        self.tx.try_send(batch).map_err(|err| match err {
            mpsc::error::TrySendError::Full(_) => EnqueueError::Full,
            mpsc::error::TrySendError::Closed(_) => EnqueueError::Closed,
        })
    }
}

/// Build a ClickHouse client from configuration.
pub fn build_client(config: &Config) -> Client {
    Client::default()
        .with_url(&config.clickhouse_url)
        .with_database(&config.clickhouse_database)
        .with_user(&config.clickhouse_user)
        .with_password(&config.clickhouse_password)
}

/// Spawn the background writer. Returns the ingest handle and the task handle;
/// await the latter on shutdown to flush buffered rows.
pub fn spawn_writer(client: Client, config: &Config) -> (Ingestor, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Converted>(config.channel_capacity);
    let handle = tokio::spawn(writer_loop(
        client,
        rx,
        config.batch_max_rows,
        config.batch_flush_interval,
    ));
    (Ingestor { tx }, handle)
}

async fn writer_loop(
    client: Client,
    mut rx: mpsc::Receiver<Converted>,
    max_rows: usize,
    flush_interval: Duration,
) {
    let mut spans: Vec<SpanRow> = Vec::new();
    let mut events: Vec<SpanEventRow> = Vec::new();

    let mut ticker = tokio::time::interval(flush_interval);
    // Time-based flush is a floor on latency, not a scheduling guarantee: if a
    // flush runs long, skip the missed ticks rather than firing a burst.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe_batch = rx.recv() => match maybe_batch {
                Some(batch) => {
                    spans.extend(batch.spans);
                    events.extend(batch.events);
                    if spans.len() >= max_rows || events.len() >= max_rows {
                        flush(&client, &mut spans, &mut events).await;
                    }
                }
                None => {
                    // All senders dropped (shutdown): drain and exit.
                    flush(&client, &mut spans, &mut events).await;
                    break;
                }
            },
            _ = ticker.tick() => {
                flush(&client, &mut spans, &mut events).await;
            }
        }
    }

    tracing::info!("writer task stopped");
}

/// Flush both buffers. A failed insert is logged and the batch dropped rather
/// than retried indefinitely (which would grow memory without bound if
/// ClickHouse stayed down); buffers are always cleared so one bad batch cannot
/// wedge the pipeline. Durable retry/dead-lettering is a roadmap item.
async fn flush(client: &Client, spans: &mut Vec<SpanRow>, events: &mut Vec<SpanEventRow>) {
    if !spans.is_empty() {
        if let Err(err) = insert_rows(client, "spans", spans).await {
            tracing::error!(error = %err, count = spans.len(), "failed to write spans batch");
        }
        spans.clear();
    }
    if !events.is_empty() {
        if let Err(err) = insert_rows(client, "span_events", events).await {
            tracing::error!(error = %err, count = events.len(), "failed to write span_events batch");
        }
        events.clear();
    }
}

async fn insert_rows<T>(client: &Client, table: &str, rows: &[T]) -> clickhouse::error::Result<()>
where
    // Owned rows (no borrowed columns) serialize as themselves: Value<'a> == T.
    T: serde::Serialize + for<'a> clickhouse::Row<Value<'a> = T>,
{
    let mut insert = client.insert::<T>(table).await?;
    for row in rows {
        insert.write(row).await?;
    }
    insert.end().await
}
