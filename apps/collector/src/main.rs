//! TraceBloom collector binary: a thin wrapper around the library `run`, plus
//! a `healthcheck` subcommand used as the container HEALTHCHECK (the slim
//! runtime image ships no curl/wget; the binary probes its own /health).

use std::time::Duration;

use tracebloom_collector::{config::Config, health::probe_health, init_tracing, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        let config = Config::from_env();
        let healthy = probe_health(&config.bind_addr, Duration::from_secs(3));
        std::process::exit(if healthy { 0 } else { 1 });
    }

    init_tracing();
    run(Config::from_env()).await
}
