//! api-server: axum REST + WS (spec section 7.4).
//!
//! Exposed as a library (in addition to the `api-server` binary) so
//! integration tests can build the router directly without spawning a
//! subprocess. Phase 1: `GET /api/v1/healthz` + `/ws` (snapshot on
//! connect, tick/agent event broadcast, time controls). ADR-002 D2/D5
//! (Phase 3 前置) adds the world-configuration REST surface: `GET/PUT
//! /api/v1/world/map`, `PUT /api/v1/world/layout`, `PATCH
//! /api/v1/agents/:id` (see `world_api`/`agents_api`).

pub mod agents_api;
pub mod db_persist;
pub mod error;
pub mod healthz;
pub mod router;
pub mod sim;
pub mod state;
pub mod world_api;
pub mod ws;
