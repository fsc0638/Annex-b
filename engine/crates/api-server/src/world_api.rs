//! ADR-002 D2 world-configuration REST endpoints:
//! - `GET  /api/v1/world/map`
//! - `PUT  /api/v1/world/map`
//! - `PUT  /api/v1/world/layout`
//!
//! Both PUT handlers follow the same shape: validate under the world lock
//! (`WorldState::replace_map` / `replace_layout` are self-validating and
//! never partially mutate on error) -> on success, broadcast the full
//! `world_snapshot` on the same channel the tick loop uses (so it is
//! serialized against ticks by the world lock, exactly like `ws.rs`'s
//! `world_paused` send) -> release the lock -> persist (fixture file or DB,
//! depending on `AppState.db`) -> return the snapshot as the HTTP response
//! body too, so the caller doesn't need a second round trip to see the
//! post-change state.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use sim_core::LayoutItem;

use crate::db_persist;
use crate::error::ApiError;
use crate::state::{AppState, SimHandle};

fn require_sim(state: &AppState) -> Result<Arc<SimHandle>, ApiError> {
    state.sim.clone().ok_or_else(|| {
        ApiError::service_unavailable("world not loaded (check WORLD_SOURCE / DATABASE_URL)")
    })
}

#[derive(Debug, Deserialize)]
pub struct PutMapBody {
    pub tmj: Value,
}

#[derive(Debug, Deserialize)]
pub struct PutLayoutBody {
    pub items: Vec<LayoutItem>,
}

pub async fn get_map(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let sim = require_sim(&state)?;
    let world = sim.world.lock().await;
    Ok(Json(serde_json::json!({
        "tmj": world.map_json,
        "map_rev": world.map_rev,
    })))
}

pub async fn put_map(
    State(state): State<AppState>,
    body: Result<Json<PutMapBody>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let sim = require_sim(&state)?;
    let Json(body) =
        body.map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))?;
    let tmj_str = serde_json::to_string(&body.tmj)
        .map_err(|e| ApiError::bad_request(format!("tmj must be valid JSON: {e}")))?;

    let snapshot = {
        let mut world = sim.world.lock().await;
        world
            .replace_map(&tmj_str)
            .map_err(ApiError::unprocessable)?;
        let snap = world.snapshot_json();
        // Sent while still holding the world lock — same ordering
        // guarantee as the tick loop and ws.rs's world_paused send (see
        // api_server::sim::spawn_tick_loop's doc comment): no tick from a
        // step racing this replace can land out of order relative to this
        // snapshot on the broadcast channel.
        let _ = sim.events.send(snap.to_string());
        snap
    };

    if let Some(pool) = &state.db {
        let world = sim.world.lock().await;
        if let Err(e) = db_persist::save_map(pool, world.world.id, &world.map_json).await {
            tracing::warn!(error = %e, "failed to persist worlds.map_tmj");
        }
    } else {
        persist_fixture(&sim).await;
    }

    Ok(Json(snapshot))
}

pub async fn put_layout(
    State(state): State<AppState>,
    body: Result<Json<PutLayoutBody>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let sim = require_sim(&state)?;
    let Json(body) =
        body.map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))?;

    let snapshot = {
        let mut world = sim.world.lock().await;
        world
            .replace_layout(body.items)
            .map_err(ApiError::unprocessable)?;
        let snap = world.snapshot_json();
        let _ = sim.events.send(snap.to_string());
        snap
    };

    if let Some(pool) = &state.db {
        let world = sim.world.lock().await;
        if let Err(e) = db_persist::save_layout(pool, world.world.id, &world.layout).await {
            tracing::warn!(error = %e, "failed to persist layout_items");
        }
    } else {
        persist_fixture(&sim).await;
    }

    Ok(Json(snapshot))
}

/// Fixture-mode persistence (ADR-002 D3): atomically rewrites the whole
/// `WORLD_SAVE_PATH` file from the current world state. A failure here is
/// logged and otherwise swallowed — the in-memory mutation already
/// succeeded and was already broadcast; losing the save-to-disk step just
/// means a restart would fall back to the last successfully-persisted
/// state (or the seed fixture) instead of this one, not a request failure.
///
/// Only the cheap in-memory snapshot ([`build_save_file`]) runs under the
/// world lock; the lock is released before the (serialize + temp-file +
/// rename) disk write, so a slow filesystem never blocks other request
/// handlers or the tick loop waiting on the world lock. Persistence is still
/// awaited before the caller returns its HTTP response — the save-before-
/// respond ordering is unchanged; only the lock hold time shrinks.
pub(crate) async fn persist_fixture(sim: &Arc<SimHandle>) {
    let save = {
        let world = sim.world.lock().await;
        sim_core::persist::build_save_file(&world)
        // world lock released here, before any filesystem I/O.
    };
    let path = sim_core::persist::save_path_from_env();
    if let Err(e) = sim_core::persist::save_file_to_path(&save, &path) {
        tracing::warn!(error = %e, path, "failed to persist world save file");
    }
}
