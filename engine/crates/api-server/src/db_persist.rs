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

use sqlx::{PgPool, Row};
use uuid::Uuid;

use sim_core::{Agent, LayoutItem};

/// Re-associates each agent with the *equivalent* desk in a freshly-reinserted
/// layout, keyed on the stable business key (`layout_items.key`, which is
/// `unique (world_id, key)` per `001_init.sql`) rather than the row UUID.
///
/// Correctness argument: `save_layout` deletes then reinserts the layout
/// rows. The `agents.desk_id` FK is `on delete set null`, so the delete nulls
/// every agent's seat. We must restore it. Restoring the *old UUID* is only
/// safe if the reinsert happens to reuse the same primary keys — which we do
/// not want to depend on (a future editor could regenerate ids). The desk's
/// `key` (e.g. `deskA-07`, `exec.vp`) is the stable identity of "the same
/// desk" across the replace, so we snapshot each agent's desk key before the
/// delete and, after reinsert, point the agent at whichever new row carries
/// that key. An agent whose old desk key is absent from the new layout is
/// left unassigned (desk_id stays null) rather than pointed at a bogus row.
fn remap_desk_assignments(
    snapshot: &[(Uuid, String)],
    new_layout: &[LayoutItem],
) -> Vec<(Uuid, Uuid)> {
    let key_to_id: std::collections::HashMap<&str, Uuid> = new_layout
        .iter()
        .map(|it| (it.key.as_str(), it.id))
        .collect();
    snapshot
        .iter()
        .filter_map(|(agent_id, desk_key)| {
            key_to_id
                .get(desk_key.as_str())
                .map(|new_desk_id| (*agent_id, *new_desk_id))
        })
        .collect()
}

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

    // Snapshot each agent's desk *by business key* BEFORE the delete. The
    // `agents.desk_id` FK is `on delete set null`, so the delete below would
    // otherwise silently unseat every agent, and on next load they'd have no
    // desk. Joining through the current desk row captures the stable key we
    // re-link on after the reinsert (see `remap_desk_assignments`).
    let desk_snapshot: Vec<(Uuid, String)> = sqlx::query(
        "select a.id, li.key from agents a \
         join layout_items li on li.id = a.desk_id \
         where a.world_id = $1",
    )
    .bind(world_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| format!("db: failed to snapshot agent desk assignments: {e}"))?
    .into_iter()
    .map(|row| (row.get::<Uuid, _>("id"), row.get::<String, _>("key")))
    .collect();

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

    // Restore each agent's seat, re-linking on the stable desk key so this is
    // correct whether the reinsert reused the old row ids or minted new ones.
    // Done inside the same transaction as the delete/reinsert, so an observer
    // never sees the intermediate all-seats-null state.
    for (agent_id, new_desk_id) in remap_desk_assignments(&desk_snapshot, layout) {
        sqlx::query("update agents set desk_id = $1 where id = $2")
            .bind(new_desk_id)
            .bind(agent_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("db: failed to restore desk_id for agent {agent_id}: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use sim_core::LayoutItemKind;

    fn desk(id: Uuid, key: &str) -> LayoutItem {
        LayoutItem {
            id,
            world_id: Uuid::nil(),
            kind: LayoutItemKind::Desk,
            key: key.into(),
            name: key.into(),
            pos_x: 1,
            pos_y: 1,
            w: 1,
            h: 1,
            rotation: 0,
            zone: "common".into(),
            walkable: false,
            affords: vec![],
            meta: serde_json::Value::Null,
        }
    }

    #[test]
    fn remap_relinks_on_key_when_reinsert_reuses_ids() {
        let desk_id = Uuid::new_v4();
        let agent = Uuid::new_v4();
        let snapshot = vec![(agent, "deskA-01".to_string())];
        // New layout keeps the same id for the same key.
        let new_layout = vec![desk(desk_id, "deskA-01")];
        assert_eq!(
            remap_desk_assignments(&snapshot, &new_layout),
            vec![(agent, desk_id)]
        );
    }

    #[test]
    fn remap_relinks_on_key_even_when_reinsert_regenerates_ids() {
        let old_desk_id = Uuid::new_v4();
        let new_desk_id = Uuid::new_v4();
        assert_ne!(old_desk_id, new_desk_id);
        let agent = Uuid::new_v4();
        // Agent's desk was captured under the OLD uuid, but the reinserted
        // row for the same business key carries a NEW uuid. The remap must
        // follow the key to the new id, not blindly reuse the old uuid.
        let snapshot = vec![(agent, "deskA-01".to_string())];
        let new_layout = vec![desk(new_desk_id, "deskA-01")];
        let remap = remap_desk_assignments(&snapshot, &new_layout);
        assert_eq!(remap, vec![(agent, new_desk_id)]);
        assert_ne!(remap[0].1, old_desk_id, "must not restore the stale uuid");
    }

    #[test]
    fn remap_drops_agent_whose_desk_key_is_gone() {
        let agent = Uuid::new_v4();
        let snapshot = vec![(agent, "deskA-01".to_string())];
        // The new layout no longer contains that desk key.
        let new_layout = vec![desk(Uuid::new_v4(), "deskA-99")];
        assert!(
            remap_desk_assignments(&snapshot, &new_layout).is_empty(),
            "an agent whose desk was removed stays unassigned, not pointed at a bogus row"
        );
    }
}
