//! Shared application state for axum handlers.

use std::sync::Arc;

use llm_gateway::Gateway;
use sqlx::PgPool;

/// `db` is `None` when `DATABASE_URL` is unset or the connection failed at
/// startup — Phase 0 allows the server to boot without a DB so `healthz`
/// can honestly report "db: unreachable" rather than crash-looping. Later
/// phases that need the DB for real request handling should treat a
/// missing pool as a 503, not a panic.
#[derive(Clone)]
pub struct AppState {
    pub db: Option<PgPool>,
    pub gateway: Arc<Gateway>,
}
