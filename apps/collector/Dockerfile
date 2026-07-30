# Multi-stage build for the TraceBloom collector.
# Build context is the repo root (see infra/docker-compose.yml) so the Cargo
# workspace manifest and lockfile are available for a reproducible build.

FROM rust:1.95-slim-bookworm AS builder
WORKDIR /build

# Copy the workspace manifest + lockfile and the single member crate. We do NOT
# copy rust-toolchain.toml so the build uses the image's pinned 1.95 toolchain
# without an extra rustup download. The clickhouse client uses pure-Rust lz4 and
# cityhash, so no C/C++ toolchain or system libraries are needed.
COPY Cargo.toml Cargo.lock ./
COPY apps/collector ./apps/collector

RUN cargo build --release --locked -p tracebloom-collector

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 tracebloom

COPY --from=builder /build/target/release/tracebloom-collector /usr/local/bin/tracebloom-collector

USER tracebloom
EXPOSE 4318
ENV TRACEBLOOM_BIND_ADDR=0.0.0.0:4318 \
    RUST_LOG=info
# The binary probes its own /health (no curl/wget in the slim runtime).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/tracebloom-collector", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/tracebloom-collector"]
