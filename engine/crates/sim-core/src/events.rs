//! Simulation events broadcast to WebSocket clients (spec 7.4 subset for
//! Phase 1). Serialized with a snake_case `type` tag to match the wire
//! protocol examples in the spec.

use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimEvent {
    /// One tick advanced. `speed` rides along so every client can keep its
    /// speed selector in sync (7.4 leaves tick's payload open).
    Tick {
        sim_day: i32,
        sim_clock_sec: i32,
        speed: u32,
    },
    AgentMoved {
        agent_id: Uuid,
        x: i32,
        y: i32,
    },
    AgentStatus {
        agent_id: Uuid,
        status: String,
    },
    /// Spec 7.4 lists world_paused; emitted on a pause control so all
    /// connected clients freeze their UI state together.
    WorldPaused,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_snake_case_type_tags() {
        let tick = serde_json::to_value(SimEvent::Tick {
            sim_day: 1,
            sim_clock_sec: 25210,
            speed: 2,
        })
        .unwrap();
        assert_eq!(tick["type"], "tick");
        assert_eq!(tick["sim_clock_sec"], 25210);
        assert_eq!(tick["speed"], 2);

        let moved = serde_json::to_value(SimEvent::AgentMoved {
            agent_id: Uuid::nil(),
            x: 3,
            y: 4,
        })
        .unwrap();
        assert_eq!(moved["type"], "agent_moved");
        assert_eq!(moved["x"], 3);

        let status = serde_json::to_value(SimEvent::AgentStatus {
            agent_id: Uuid::nil(),
            status: "seated".into(),
        })
        .unwrap();
        assert_eq!(status["type"], "agent_status");
        assert_eq!(status["status"], "seated");

        let paused = serde_json::to_value(SimEvent::WorldPaused).unwrap();
        assert_eq!(paused["type"], "world_paused");
    }
}
