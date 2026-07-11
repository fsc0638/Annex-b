//! DB-mode persistence for the ADR-002 D2 REST endpoints (D3: "db 模式：
//! layout/agents 走 SQL UPDATE（runtime query 鐵則不變）；地圖存
//! worlds.map_tmj jsonb"). Every query here is a plain `sqlx::query(...)`
//! with bound parameters — never the `query!` compile-time macro family
//! (repo rule, docs/CLAUDE.md: no DB reachable at build time).
//!
//! This path only compiles + is unit-tested locally (no Docker/psql on the
//! dev machine, per ADR-002's recon); first real-DB verification is a
//! deployment-machine task like the rest of the `db` feature surface (see
//! docs/CLAUDE.md "已知缺口").

use sqlx::PgPool;
use uuid::Uuid;

use sim_core::{Agent, LayoutItem};

pub async fn save_map(
    pool: &PgPool,
    world_id: Uuid,
    map_tmj: &serde_json::Value,
) -> Result<(), String> {
    sqlx::query("update worlds set map_tmj = $1 where id = $2")
        .bind(map_tmj)
        .bind(world_id)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| format!("db: failed to update worlds.map_tmj: {e}"))
}

/// Replaces every `layout_items` row for `world_id` with `layout` inside a
/// transaction (delete-then-reinsert, same replace strategy as the fixture
/// save file — layout_items has no natural per-row upsert key stable
/// across an editor session that can add/remove/reorder items freely).
pub async fn save_layout(
    pool: &PgPool,
    world_id: Uuid,
    layout: &[LayoutItem],
) -> Result<(), String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("db: failed to begin layout_items transaction: {e}"))?;

    sqlx::query("delete from layout_items where world_id = $1")
        .bind(world_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("db: failed to clear layout_items: {e}"))?;

    for item in layout {
        sqlx::query(
            "insert into layout_items \
             (id, world_id, kind, key, name, pos_x, pos_y, w, h, rotation, zone, walkable, affords, meta) \
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(item.id)
        .bind(world_id)
        .bind(item.kind.as_db_str())
        .bind(&item.key)
        .bind(&item.name)
        .bind(item.pos_x)
        .bind(item.pos_y)
        .bind(item.w)
        .bind(item.h)
        .bind(item.rotation)
        .bind(&item.zone)
        .bind(item.walkable)
        .bind(&item.affords)
        .bind(&item.meta)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("db: failed to insert layout_items '{}': {e}", item.key))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("db: failed to commit layout_items transaction: {e}"))
}

/// Writes back the editable fields of one agent (ADR-002 D5). Position,
/// status, and desk assignment are simulation-runtime state, not editor
/// output, so they are intentionally not part of this write.
pub async fn save_agent(pool: &PgPool, agent: &Agent) -> Result<(), String> {
    sqlx::query(
        "update agents set name = $1, seed_traits = $2, core_identity = $3, reply_style = $4, \
         llm_profile = $5 where id = $6",
    )
    .bind(&agent.name)
    .bind(&agent.seed_traits)
    .bind(&agent.core_identity)
    .bind(&agent.reply_style)
    .bind(&agent.llm_profile)
    .bind(agent.id)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|e| format!("db: failed to update agents row {}: {e}", agent.id))
}
