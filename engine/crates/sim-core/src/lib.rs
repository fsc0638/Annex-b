//! sim-core: world state, tick loop, A*, layout collision rebuild, event bus.
//!
//! Phase 0 established the domain types mirroring `db/migrations/001_init.sql`
//! (kept below in this file). Phase 1 adds the office-world simulation:
//!
//! - [`tilemap`]: parses the Tiled `.tmj` shell map (walls carry a custom
//!   `collides=true` property; door tiles are the walkable gaps in the ring).
//! - [`grid`]: collision grid = tmj walls ⊕ non-walkable layout footprints
//!   (rotation-aware).
//! - [`pathfind`]: deterministic 4-directional A* with Manhattan heuristic.
//! - [`clock`]: game-time helpers and the wall-clock tick interval rule.
//! - [`commute`]: Appendix A.2 commute schedule (Phase 1 world script).
//! - [`world`]: [`world::WorldState`] — in-memory world + `step()` tick.
//! - [`events`]: [`events::SimEvent`] broadcast payloads (spec 7.4 subset).
//! - [`fixture`]: DB-less loading from the world fixture JSON + tmj.
//! - [`db`] (feature `db`): sqlx **runtime-query** loading path (repo rule:
//!   never `query!` compile-time macros — no DB at build time).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod clock;
pub mod commute;
#[cfg(feature = "db")]
pub mod db;
pub mod events;
pub mod fixture;
pub mod grid;
pub mod pathfind;
pub mod tilemap;
pub mod world;

/// Mirrors the `worlds` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct World {
    pub id: Uuid,
    pub name: String,
    pub seed: i64,
    pub sim_day: i32,
    /// Seconds since 00:00 game time. Default 25200 = 07:00 kickoff.
    pub sim_clock_sec: i32,
    pub tick_ms: i32,
    pub sec_per_tick: i32,
    pub status: WorldStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorldStatus {
    Paused,
    Running,
    Editing,
    Archived,
}

impl WorldStatus {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            WorldStatus::Paused => "paused",
            WorldStatus::Running => "running",
            WorldStatus::Editing => "editing",
            WorldStatus::Archived => "archived",
        }
    }

    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "paused" => Some(WorldStatus::Paused),
            "running" => Some(WorldStatus::Running),
            "editing" => Some(WorldStatus::Editing),
            "archived" => Some(WorldStatus::Archived),
            _ => None,
        }
    }
}

/// Mirrors the `agents` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: Uuid,
    pub world_id: Uuid,
    pub name: String,
    pub sprite_key: String,
    pub grade: String,
    pub title: String,
    pub reports_to: Option<Uuid>,
    pub core_identity: String,
    pub seed_traits: String,
    pub current_status: String,
    pub pos_x: i32,
    pub pos_y: i32,
    pub desk_id: Option<Uuid>,
    /// Per-agent LLM tier override, e.g. {"L1":"openai:gpt-4o-mini"}.
    /// Empty object means "use tier defaults" (section 6).
    pub llm_profile: serde_json::Value,
}

/// Mirrors the `layout_items` table (the layout editor's data source).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutItem {
    pub id: Uuid,
    pub world_id: Uuid,
    pub kind: LayoutItemKind,
    pub key: String,
    pub name: String,
    pub pos_x: i32,
    pub pos_y: i32,
    pub w: i32,
    pub h: i32,
    pub rotation: i32,
    pub zone: String,
    pub walkable: bool,
    pub affords: Vec<String>,
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutItemKind {
    Desk,
    ExecDesk,
    Chair,
    Partition,
    MeetingTable,
    Cabinet,
    Printer,
    Plant,
    PantryCounter,
    Whiteboard,
}

impl LayoutItemKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            LayoutItemKind::Desk => "desk",
            LayoutItemKind::ExecDesk => "exec_desk",
            LayoutItemKind::Chair => "chair",
            LayoutItemKind::Partition => "partition",
            LayoutItemKind::MeetingTable => "meeting_table",
            LayoutItemKind::Cabinet => "cabinet",
            LayoutItemKind::Printer => "printer",
            LayoutItemKind::Plant => "plant",
            LayoutItemKind::PantryCounter => "pantry_counter",
            LayoutItemKind::Whiteboard => "whiteboard",
        }
    }

    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "desk" => Some(LayoutItemKind::Desk),
            "exec_desk" => Some(LayoutItemKind::ExecDesk),
            "chair" => Some(LayoutItemKind::Chair),
            "partition" => Some(LayoutItemKind::Partition),
            "meeting_table" => Some(LayoutItemKind::MeetingTable),
            "cabinet" => Some(LayoutItemKind::Cabinet),
            "printer" => Some(LayoutItemKind::Printer),
            "plant" => Some(LayoutItemKind::Plant),
            "pantry_counter" => Some(LayoutItemKind::PantryCounter),
            "whiteboard" => Some(LayoutItemKind::Whiteboard),
            _ => None,
        }
    }
}

/// Mirrors the `work_items` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: Uuid,
    pub world_id: Uuid,
    pub kind: String,
    pub title: String,
    pub client: String,
    pub owner_id: Option<Uuid>,
    pub collaborators: Vec<Uuid>,
    pub status: String,
    pub priority: i32,
    pub due_day: Option<i32>,
    pub progress: i32,
    pub last_note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_item_kind_db_str_round_trip() {
        assert_eq!(LayoutItemKind::Desk.as_db_str(), "desk");
        assert_eq!(LayoutItemKind::ExecDesk.as_db_str(), "exec_desk");
        assert_eq!(LayoutItemKind::PantryCounter.as_db_str(), "pantry_counter");
    }

    #[test]
    fn world_status_serializes_snake_case() {
        let s = serde_json::to_string(&WorldStatus::Editing).unwrap();
        assert_eq!(s, "\"editing\"");
    }
}
