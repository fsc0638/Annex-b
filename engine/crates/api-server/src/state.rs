//! Shared application state for axum handlers.

use std::sync::Arc;

use llm_gateway::Gateway;
use sim_core::world::WorldState;
use sqlx::PgPool;
use tokio::sync::{broadcast, Mutex};

/// Broadcast channel capacity for simulation events. A tick at x5 speed
/// produces one small batch every 200ms; 256 buffered events give slow
/// clients seconds of slack. A client that still lags is disconnected by
/// its ws task and reconnects to a fresh snapshot (see ws.rs).
pub const EVENT_CHANNEL_CAPACITY: usize = 256;

/// The resident world plus its event fan-out. Events are broadcast as
/// pre-serialized JSON strings so each event is serialized once, not once
/// per connected client.
pub struct SimHandle {
    pub world: Mutex<WorldState>,
    pub events: broadcast::Sender<String>,
}

impl SimHandle {
    pub fn new(world: WorldState) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Arc::new(SimHandle {
            world: Mutex::new(world),
            events,
        })
    }
}

/// `db` is `None` when `DATABASE_URL` is unset or the connection failed at
/// startup — Phase 0 allows the server to boot without a DB so `healthz`
/// can honestly report "db: unreachable" rather than crash-looping. Later
/// phases that need the DB for real request handling should treat a
/// missing pool as a 503, not a panic.
///
/// `sim` is `None` when no world could be loaded at startup (e.g.
/// WORLD_SOURCE=db without a reachable DB) — `/ws` then answers 503 and
/// the rest of the server still works, mirroring the `db` philosophy.
#[derive(Clone)]
pub struct AppState {
    pub db: Option<PgPool>,
    pub gateway: Arc<Gateway>,
    pub sim: Option<Arc<SimHandle>>,
}
