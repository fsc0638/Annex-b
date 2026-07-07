use axum::{routing::get, Router};

use crate::healthz::healthz;
use crate::state::AppState;
use crate::ws::ws_handler;

/// Builds the axum router. Phase 1 scope: `GET /api/v1/healthz` and the
/// `/ws` WebSocket (spec 7.4). The rest of `/api/v1/*` (layout PUT, work
/// items, world creation) is Phase 3+.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .with_state(state)
}
