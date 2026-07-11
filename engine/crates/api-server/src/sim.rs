//! World loading (WORLD_SOURCE=db|fixture) and the wall-clock tick loop
//! (Phase 1 T1.3).
//!
//! The loop is deliberately thin: all simulation logic lives in
//! `sim_core::world::WorldState::step()` (synchronous, testable headless);
//! this task only owns the timer and the broadcast fan-out.

use std::sync::Arc;

use sim_core::clock::tick_interval_ms;
use sim_core::world::WorldState;
use sqlx::PgPool;

use crate::state::SimHandle;

/// Where the resident world comes from (env `WORLD_SOURCE`):
/// - `db` (default): most recent world from PostgreSQL (compose target).
/// - `fixture`: DB-less demo mode from the sim-core world fixture — the
///   local dev machine has no DB, so this is also how the Phase 1 demo
///   runs there.
pub enum WorldSource {
    Db,
    Fixture,
}

impl WorldSource {
    pub fn from_env() -> Result<Self, String> {
        match std::env::var("WORLD_SOURCE").as_deref() {
            Err(_) | Ok("db") => Ok(WorldSource::Db),
            Ok("fixture") => Ok(WorldSource::Fixture),
            Ok(other) => Err(format!(
                "unknown WORLD_SOURCE '{other}' (expected 'db' or 'fixture')"
            )),
        }
    }
}

/// Compile-time defaults resolve relative to this crate's manifest dir,
/// which is correct on the dev machine (repo checkout). In containers,
/// set the env vars explicitly.
fn tmj_path() -> String {
    std::env::var("TMJ_PATH").unwrap_or_else(|_| {
        format!(
            "{}/../../../assets/maps/office_shell.tmj",
            env!("CARGO_MANIFEST_DIR")
        )
    })
}

fn fixture_path() -> String {
    std::env::var("FIXTURE_PATH").unwrap_or_else(|_| {
        format!(
            "{}/../sim-core/tests/fixtures/world_fixture.json",
            env!("CARGO_MANIFEST_DIR")
        )
    })
}

fn read_tmj() -> Result<String, String> {
    let path = tmj_path();
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read tmj at {path}: {e}"))
}

/// Loads the resident world according to WORLD_SOURCE. `pool` is only
/// used for the `db` source.
pub async fn load_world_state(pool: Option<&PgPool>) -> Result<WorldState, String> {
    let tmj = read_tmj()?;
    match WorldSource::from_env()? {
        WorldSource::Fixture => {
            let path = fixture_path();
            let fixture_json = std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read fixture at {path}: {e}"))?;
            let base = WorldState::from_fixture_strs(&fixture_json, &tmj)?;
            // ADR-002 D3: a persisted world save (from a previous PUT
            // /world/map, /world/layout, or PATCH /agents/:id) takes
            // priority over the seed fixture, if present and still valid
            // against it. A missing file is the normal first-boot case
            // (no WARN); a corrupt/incompatible file is ignored with a
            // WARN and the seed fixture is used as-is — never a crash.
            let save_path = sim_core::persist::save_path_from_env();
            match sim_core::persist::try_load_and_apply(&base, &save_path) {
                Ok(Some(loaded)) => {
                    tracing::info!(path = %save_path, "loaded persisted world save over the seed fixture");
                    Ok(loaded)
                }
                Ok(None) => Ok(base),
                Err(e) => {
                    tracing::warn!(error = %e, path = %save_path, "ignoring invalid world save file; using seed fixture");
                    Ok(base)
                }
            }
        }
        WorldSource::Db => {
            let pool = pool.ok_or(
                "WORLD_SOURCE=db but no database connection (set DATABASE_URL, \
                 or use WORLD_SOURCE=fixture for the DB-less demo mode)",
            )?;
            let loaded = sim_core::db::load_world(pool, None).await?;
            WorldState::from_parts(
                loaded.world,
                loaded.agents,
                loaded.layout,
                loaded.work_items,
                &tmj,
            )
        }
    }
}

/// Spawns the tick loop: every `tick_ms / speed` wall-clock milliseconds,
/// advance one tick and broadcast its events. Re-reads tick_ms/speed each
/// iteration so `set_speed` takes effect from the next tick. Runs forever
/// (paused worlds still tick the timer but `step()` no-ops cheaply).
///
/// Ordering guarantee: events are sent on the broadcast channel WHILE the
/// world lock is still held. Every other broadcaster (ws.rs sends
/// `world_paused` under the same lock) is therefore serialized against
/// tick events by the lock itself — a `world_paused` on the channel can
/// never overtake, nor be overtaken by, the tick events of a step on the
/// other side of the pause. (broadcast::Sender::send is sync and
/// non-blocking, so sending under the lock costs nothing.)
pub fn spawn_tick_loop(handle: Arc<SimHandle>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let interval = {
                let world = handle.world.lock().await;
                tick_interval_ms(world.world.tick_ms, world.speed)
            };
            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;

            {
                let mut world = handle.world.lock().await;
                for event in world.step() {
                    match serde_json::to_string(&event) {
                        Ok(json) => {
                            // send() only fails when there are no
                            // subscribers — that's fine (nobody watching),
                            // not an error.
                            let _ = handle.events.send(json);
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "failed to serialize sim event");
                        }
                    }
                }
            }
        }
    })
}
