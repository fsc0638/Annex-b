//! DB loading path (feature `db`) — sqlx **runtime queries only**.
//!
//! Repo-wide rule (docs/CLAUDE.md): never use the `query!` compile-time
//! macro family — the local dev environment has no database at build
//! time, so compile-time schema checking would break the build. Every
//! query below is a plain `sqlx::query(...)` with `try_get` row reads.
//!
//! This path is exercised for real only in the compose environment
//! (api-server `WORLD_SOURCE=db`, the default); locally it just has to
//! compile and is covered by the fixture path's shared `from_parts`.

use sqlx::postgres::PgPool;
use sqlx::Row;
use uuid::Uuid;

use crate::{Agent, LayoutItem, LayoutItemKind, WorkItem, World, WorldStatus};

/// Everything needed to build a `WorldState` (pair with the tmj text via
/// `WorldState::from_parts`).
#[derive(Debug, Clone)]
pub struct LoadedWorld {
    pub world: World,
    pub agents: Vec<Agent>,
    pub layout: Vec<LayoutItem>,
    pub work_items: Vec<WorkItem>,
}

/// Loads a world and its agents/layout/work_items. `world_id: None` picks
/// the most recently created world (matching seed_world.sh's "most recent
/// world" convention).
pub async fn load_world(pool: &PgPool, world_id: Option<Uuid>) -> Result<LoadedWorld, String> {
    let world_row = match world_id {
        Some(id) => {
            sqlx::query(
                "select id, name, seed, sim_day, sim_clock_sec, tick_ms, sec_per_tick, status \
             from worlds where id = $1",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
        }
        None => {
            sqlx::query(
                "select id, name, seed, sim_day, sim_clock_sec, tick_ms, sec_per_tick, status \
             from worlds order by created_at desc limit 1",
            )
            .fetch_optional(pool)
            .await
        }
    }
    .map_err(|e| format!("db: worlds query failed: {e}"))?
    .ok_or("db: no world found (run scripts/seed_world.sh first)")?;

    let status_str: String = world_row
        .try_get("status")
        .map_err(|e| format!("db: worlds.status: {e}"))?;
    let world = World {
        id: world_row
            .try_get("id")
            .map_err(|e| format!("db: worlds.id: {e}"))?,
        name: world_row
            .try_get("name")
            .map_err(|e| format!("db: worlds.name: {e}"))?,
        seed: world_row
            .try_get("seed")
            .map_err(|e| format!("db: worlds.seed: {e}"))?,
        sim_day: world_row
            .try_get("sim_day")
            .map_err(|e| format!("db: worlds.sim_day: {e}"))?,
        sim_clock_sec: world_row
            .try_get("sim_clock_sec")
            .map_err(|e| format!("db: worlds.sim_clock_sec: {e}"))?,
        tick_ms: world_row
            .try_get("tick_ms")
            .map_err(|e| format!("db: worlds.tick_ms: {e}"))?,
        sec_per_tick: world_row
            .try_get("sec_per_tick")
            .map_err(|e| format!("db: worlds.sec_per_tick: {e}"))?,
        status: WorldStatus::from_db_str(&status_str)
            .ok_or_else(|| format!("db: unknown worlds.status '{status_str}'"))?,
    };

    let agent_rows = sqlx::query(
        "select id, world_id, name, sprite_key, grade, title, reports_to, core_identity, \
         seed_traits, reply_style, current_status, pos_x, pos_y, desk_id, llm_profile \
         from agents where world_id = $1 order by name",
    )
    .bind(world.id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("db: agents query failed: {e}"))?;
    let mut agents = Vec::with_capacity(agent_rows.len());
    for row in agent_rows {
        agents.push(Agent {
            id: row
                .try_get("id")
                .map_err(|e| format!("db: agents.id: {e}"))?,
            world_id: row
                .try_get("world_id")
                .map_err(|e| format!("db: agents.world_id: {e}"))?,
            name: row
                .try_get("name")
                .map_err(|e| format!("db: agents.name: {e}"))?,
            sprite_key: row
                .try_get("sprite_key")
                .map_err(|e| format!("db: agents.sprite_key: {e}"))?,
            grade: row
                .try_get("grade")
                .map_err(|e| format!("db: agents.grade: {e}"))?,
            title: row
                .try_get("title")
                .map_err(|e| format!("db: agents.title: {e}"))?,
            reports_to: row
                .try_get("reports_to")
                .map_err(|e| format!("db: agents.reports_to: {e}"))?,
            core_identity: row
                .try_get("core_identity")
                .map_err(|e| format!("db: agents.core_identity: {e}"))?,
            seed_traits: row
                .try_get("seed_traits")
                .map_err(|e| format!("db: agents.seed_traits: {e}"))?,
            reply_style: row
                .try_get("reply_style")
                .map_err(|e| format!("db: agents.reply_style: {e}"))?,
            current_status: row
                .try_get("current_status")
                .map_err(|e| format!("db: agents.current_status: {e}"))?,
            pos_x: row
                .try_get("pos_x")
                .map_err(|e| format!("db: agents.pos_x: {e}"))?,
            pos_y: row
                .try_get("pos_y")
                .map_err(|e| format!("db: agents.pos_y: {e}"))?,
            desk_id: row
                .try_get("desk_id")
                .map_err(|e| format!("db: agents.desk_id: {e}"))?,
            llm_profile: row
                .try_get("llm_profile")
                .map_err(|e| format!("db: agents.llm_profile: {e}"))?,
        });
    }

    let layout_rows = sqlx::query(
        "select id, world_id, kind, key, name, pos_x, pos_y, w, h, rotation, zone, \
         walkable, affords, meta from layout_items where world_id = $1 order by key",
    )
    .bind(world.id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("db: layout_items query failed: {e}"))?;
    let mut layout = Vec::with_capacity(layout_rows.len());
    for row in layout_rows {
        let kind_str: String = row
            .try_get("kind")
            .map_err(|e| format!("db: layout_items.kind: {e}"))?;
        layout.push(LayoutItem {
            id: row
                .try_get("id")
                .map_err(|e| format!("db: layout_items.id: {e}"))?,
            world_id: row
                .try_get("world_id")
                .map_err(|e| format!("db: layout_items.world_id: {e}"))?,
            kind: LayoutItemKind::from_db_str(&kind_str)
                .ok_or_else(|| format!("db: unknown layout_items.kind '{kind_str}'"))?,
            key: row
                .try_get("key")
                .map_err(|e| format!("db: layout_items.key: {e}"))?,
            name: row
                .try_get("name")
                .map_err(|e| format!("db: layout_items.name: {e}"))?,
            pos_x: row
                .try_get("pos_x")
                .map_err(|e| format!("db: layout_items.pos_x: {e}"))?,
            pos_y: row
                .try_get("pos_y")
                .map_err(|e| format!("db: layout_items.pos_y: {e}"))?,
            w: row
                .try_get("w")
                .map_err(|e| format!("db: layout_items.w: {e}"))?,
            h: row
                .try_get("h")
                .map_err(|e| format!("db: layout_items.h: {e}"))?,
            rotation: row
                .try_get("rotation")
                .map_err(|e| format!("db: layout_items.rotation: {e}"))?,
            zone: row
                .try_get("zone")
                .map_err(|e| format!("db: layout_items.zone: {e}"))?,
            walkable: row
                .try_get("walkable")
                .map_err(|e| format!("db: layout_items.walkable: {e}"))?,
            affords: row
                .try_get("affords")
                .map_err(|e| format!("db: layout_items.affords: {e}"))?,
            meta: row
                .try_get("meta")
                .map_err(|e| format!("db: layout_items.meta: {e}"))?,
        });
    }

    let work_rows = sqlx::query(
        "select id, world_id, kind, title, client, owner_id, collaborators, status, \
         priority, due_day, progress, last_note from work_items where world_id = $1 \
         order by created_at, title",
    )
    .bind(world.id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("db: work_items query failed: {e}"))?;
    let mut work_items = Vec::with_capacity(work_rows.len());
    for row in work_rows {
        work_items.push(WorkItem {
            id: row
                .try_get("id")
                .map_err(|e| format!("db: work_items.id: {e}"))?,
            world_id: row
                .try_get("world_id")
                .map_err(|e| format!("db: work_items.world_id: {e}"))?,
            kind: row
                .try_get("kind")
                .map_err(|e| format!("db: work_items.kind: {e}"))?,
            title: row
                .try_get("title")
                .map_err(|e| format!("db: work_items.title: {e}"))?,
            client: row
                .try_get("client")
                .map_err(|e| format!("db: work_items.client: {e}"))?,
            owner_id: row
                .try_get("owner_id")
                .map_err(|e| format!("db: work_items.owner_id: {e}"))?,
            collaborators: row
                .try_get("collaborators")
                .map_err(|e| format!("db: work_items.collaborators: {e}"))?,
            status: row
                .try_get("status")
                .map_err(|e| format!("db: work_items.status: {e}"))?,
            priority: row
                .try_get("priority")
                .map_err(|e| format!("db: work_items.priority: {e}"))?,
            due_day: row
                .try_get("due_day")
                .map_err(|e| format!("db: work_items.due_day: {e}"))?,
            progress: row
                .try_get("progress")
                .map_err(|e| format!("db: work_items.progress: {e}"))?,
            last_note: row
                .try_get("last_note")
                .map_err(|e| format!("db: work_items.last_note: {e}"))?,
        });
    }

    Ok(LoadedWorld {
        world,
        agents,
        layout,
        work_items,
    })
}
