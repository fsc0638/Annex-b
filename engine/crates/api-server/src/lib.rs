//! api-server: axum REST + WS (spec section 7.4).
//!
//! Phase 0 scope: `GET /api/v1/healthz` only. Exposed as a library (in
//! addition to the `api-server` binary) so integration tests can build the
//! router directly without spawning a subprocess.

pub mod healthz;
pub mod router;
pub mod state;
