//! api-server: axum REST + WS (spec section 7.4).
//!
//! Exposed as a library (in addition to the `api-server` binary) so
//! integration tests can build the router directly without spawning a
//! subprocess. Phase 1 scope: `GET /api/v1/healthz` + `/ws` (snapshot on
//! connect, tick/agent event broadcast, time controls).

pub mod healthz;
pub mod router;
pub mod sim;
pub mod state;
pub mod ws;
