use axum::{routing::get, Router};

use crate::healthz::healthz;
use crate::state::AppState;

/// Builds the axum router. Phase 0 scope: only `GET /api/v1/healthz`.
/// `/ws` and the rest of `/api/v1/*` are Phase 1+ (spec 7.4).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/healthz", get(healthz))
        .with_state(state)
}
