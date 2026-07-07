# Multi-stage build for the Rust workspace's api-server binary.
#
# Phase 0 scope: builds and runs api-server (healthz only). sim-core,
# agent-core, and llm-gateway are linked in as library dependencies but
# have no standalone binary of their own yet.

FROM rust:1-slim-bookworm AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first for better layer caching.
COPY Cargo.toml ./
COPY crates/sim-core/Cargo.toml crates/sim-core/Cargo.toml
COPY crates/agent-core/Cargo.toml crates/agent-core/Cargo.toml
COPY crates/llm-gateway/Cargo.toml crates/llm-gateway/Cargo.toml
COPY crates/api-server/Cargo.toml crates/api-server/Cargo.toml

# Copy actual sources.
COPY crates crates

RUN cargo build --release --package api-server

# ---------------------------------------------------------------------

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/api-server /app/api-server

EXPOSE 8080
ENTRYPOINT ["/app/api-server"]
