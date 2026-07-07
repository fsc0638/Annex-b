//! sim-core: world state, tick loop, A*, layout collision rebuild, event bus.
//!
//! Phase 0 scope: domain types mirroring `db/migrations/001_init.sql` so that
//! later crates (agent-core, api-server) can share a single source of truth
//! for shapes. Tick loop, A* pathfinding, and layout collision rebuild are
//! Phase 1+ work (see spec section 8) and are intentionally NOT implemented
//! here yet.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
