//! In-memory world state and the tick step function (Phase 1 T1.2/T1.5).
//!
//! `WorldState` is the resident world (spec: 世界狀態常駐記憶體). One call
//! to [`WorldState::step`] advances exactly one tick (= `sec_per_tick`
//! game seconds) and returns the events to broadcast. The wall-clock tick
//! LOOP lives in api-server (it owns the runtime); keeping `step()`
//! synchronous and timer-free is what makes the headless commute
//! integration test possible (run 900 ticks in a tight loop, no waiting).
//!
//! Movement model: one tile per tick, 4-directional. Dynamic conflicts
//! (two agents wanting the same tile) are resolved by wait-then-reroute:
//! an agent blocked by another agent waits; after
//! [`REROUTE_AFTER_TICKS`] consecutive blocked ticks it re-runs A* with
//! all other agents' current positions as extra obstacles. Agents are
//! processed in roster order (sorted by name at load), so the whole step
//! is deterministic.

use std::collections::{HashSet, VecDeque};

use serde_json::json;
use uuid::Uuid;

use crate::commute::{commute_schedule, CommuteEntry};
use crate::events::SimEvent;
use crate::grid::CollisionGrid;
use crate::pathfind::astar;
use crate::tilemap::TileMap;
use crate::{Agent, LayoutItem, WorkItem, World, WorldStatus};

/// Consecutive blocked ticks before an agent re-routes around whoever is
/// in the way. Small enough to feel responsive, large enough to let a
/// same-direction queue drain without churn.
pub const REROUTE_AFTER_TICKS: u32 = 4;

/// Consecutive wait-then-reroute cycles (each REROUTE_AFTER_TICKS ticks)
/// without any positional progress before the agent is considered stuck
/// and a loud `stuck_in_place` event is emitted. This does NOT change the
/// wait/retry behavior itself — the agent keeps waiting and re-attempting
/// A* every cycle exactly as before — it only makes a pathological case
/// (e.g. permanently boxed in by furniture/other agents) observable
/// instead of silently retrying forever off-screen.
pub const STUCK_REROUTE_STREAK: u32 = 25;

/// Agent statuses used by the Phase 1 commute script (P0 schema
/// `current_status` semantics: seed default is `commuting`).
pub const STATUS_COMMUTING: &str = "commuting";
pub const STATUS_WALKING: &str = "walking";
pub const STATUS_SEATED: &str = "seated";

#[derive(Debug, Clone)]
pub struct AgentSim {
    pub agent: Agent,
    /// The chair tile this agent sits down on (derived from `desk_id` via
    /// the `<desk key>-chair` layout convention).
    pub chair: (i32, i32),
    pub spawn_sec: i32,
    pub spawned: bool,
    pub path: VecDeque<(i32, i32)>,
    /// Consecutive ticks spent blocked by another agent.
    pub stall_ticks: u32,
    /// Consecutive wait-then-reroute cycles whose A* re-run found no
    /// path. Resets on a successful reroute or on any actual movement.
    /// At every multiple of [`STUCK_REROUTE_STREAK`] a loud
    /// `stuck_in_place` event is emitted (see `step()`).
    pub reroute_fails: u32,
}

#[derive(Debug)]
pub struct WorldState {
    pub world: World,
    /// Runtime speed multiplier (1|2|5). Not a DB column: it scales the
    /// wall-clock tick interval only (see clock::tick_interval_ms).
    pub speed: u32,
    pub agents: Vec<AgentSim>,
    pub layout: Vec<LayoutItem>,
    pub work_items: Vec<WorkItem>,
    pub map: TileMap,
    pub grid: CollisionGrid,
}

impl WorldState {
    /// Assembles a world from already-loaded parts (fixture or DB rows)
    /// plus the tmj shell map text. Agents are sorted by name so the
    /// per-tick processing order — and therefore the whole simulation —
    /// is deterministic regardless of source row order.
    pub fn from_parts(
        world: World,
        mut agents: Vec<Agent>,
        layout: Vec<LayoutItem>,
        work_items: Vec<WorkItem>,
        tmj_str: &str,
    ) -> Result<Self, String> {
        let map = TileMap::from_tmj_str(tmj_str)?;
        if map.door_tiles.is_empty() {
            return Err("world: map has no door (no walkable ring gap)".into());
        }
        let grid = CollisionGrid::from_map_and_layout(&map, &layout);

        agents.sort_by(|a, b| a.name.cmp(&b.name));
        let schedule: Vec<CommuteEntry> = commute_schedule(&agents);

        // Chair assignment must be one-to-one: two agents resolving to the
        // same chair tile is a seed/DB configuration error (they would
        // permanently fight over one seat, or one silently overwrites the
        // other's target). Detect it loudly here rather than let it
        // surface later as an inexplicable stuck-in-place agent.
        let mut chair_owner: std::collections::HashMap<(i32, i32), String> =
            std::collections::HashMap::new();

        let mut sims = Vec::with_capacity(agents.len());
        for agent in agents {
            let desk_id = agent
                .desk_id
                .ok_or_else(|| format!("world: agent {} has no desk_id", agent.name))?;
            let desk = layout
                .iter()
                .find(|l| l.id == desk_id)
                .ok_or_else(|| format!("world: desk_id of {} not in layout", agent.name))?;
            let chair_key = format!("{}-chair", desk.key);
            let chair = layout
                .iter()
                .find(|l| l.key == chair_key)
                .ok_or_else(|| format!("world: chair '{chair_key}' not found"))?;
            if !chair.walkable {
                return Err(format!("world: chair '{chair_key}' is not walkable"));
            }
            let chair_pos = (chair.pos_x, chair.pos_y);
            if let Some(prev_agent) = chair_owner.insert(chair_pos, agent.name.clone()) {
                return Err(format!(
                    "world: chair '{chair_key}' at {chair_pos:?} is assigned to both \
                     '{prev_agent}' and '{}' — chair assignment must be one-to-one",
                    agent.name
                ));
            }
            let spawn_sec = schedule
                .iter()
                .find(|e| e.agent_id == agent.id)
                .map(|e| e.spawn_sec)
                .expect("schedule covers every agent");
            sims.push(AgentSim {
                agent,
                chair: chair_pos,
                spawn_sec,
                spawned: false,
                path: VecDeque::new(),
                stall_ticks: 0,
                reroute_fails: 0,
            });
        }

        Ok(WorldState {
            world,
            speed: 1,
            agents: sims,
            layout,
            work_items,
            map,
            grid,
        })
    }

    pub fn pause(&mut self) {
        if self.world.status == WorldStatus::Running {
            self.world.status = WorldStatus::Paused;
        }
    }

    pub fn resume(&mut self) {
        if self.world.status == WorldStatus::Paused {
            self.world.status = WorldStatus::Running;
        }
    }

    /// Valid speeds are 1|2|5 (spec 7.1 time control bar).
    pub fn set_speed(&mut self, speed: u32) -> Result<(), String> {
        if matches!(speed, 1 | 2 | 5) {
            self.speed = speed;
            Ok(())
        } else {
            Err(format!("invalid speed {speed}; allowed: 1|2|5"))
        }
    }

    /// Advances one tick. No-op (empty event list) unless status is
    /// `running` — pausing freezes game time entirely.
    pub fn step(&mut self) -> Vec<SimEvent> {
        if self.world.status != WorldStatus::Running {
            return Vec::new();
        }
        let mut events = Vec::new();

        // 1. Advance the game clock; roll the day over at midnight.
        self.world.sim_clock_sec += self.world.sec_per_tick;
        while self.world.sim_clock_sec >= crate::clock::DAY_SECS {
            self.world.sim_clock_sec -= crate::clock::DAY_SECS;
            self.world.sim_day += 1;
        }
        let clock = self.world.sim_clock_sec;

        // Occupancy of every on-floor agent (walking or seated).
        let mut occupied: HashSet<(i32, i32)> = self
            .agents
            .iter()
            .filter(|a| a.spawned)
            .map(|a| (a.agent.pos_x, a.agent.pos_y))
            .collect();

        // 2. Spawn commuters whose time has come (roster order). An agent
        //    enters at the first free door tile; if all door tiles are
        //    occupied this tick, they retry next tick.
        let door_tiles = self.map.door_tiles.clone();
        for i in 0..self.agents.len() {
            let due = !self.agents[i].spawned
                && self.agents[i].agent.current_status == STATUS_COMMUTING
                && self.agents[i].spawn_sec <= clock;
            if !due {
                continue;
            }
            let Some(&door) = door_tiles.iter().find(|d| !occupied.contains(d)) else {
                continue; // doorway crowded; try next tick
            };
            let path = astar(&self.grid, &HashSet::new(), door, self.agents[i].chair);
            let Some(path) = path else {
                // Chair unreachable on the static grid — configuration
                // error; surface loudly in the event stream but do not
                // panic the loop.
                events.push(SimEvent::AgentStatus {
                    agent_id: self.agents[i].agent.id,
                    status: "stuck_unreachable".into(),
                });
                self.agents[i].spawned = true;
                self.agents[i].agent.current_status = "stuck_unreachable".into();
                self.agents[i].agent.pos_x = door.0;
                self.agents[i].agent.pos_y = door.1;
                occupied.insert(door);
                continue;
            };
            let a = &mut self.agents[i];
            a.spawned = true;
            a.agent.pos_x = door.0;
            a.agent.pos_y = door.1;
            a.agent.current_status = STATUS_WALKING.into();
            a.path = path.into_iter().collect();
            a.stall_ticks = 0;
            a.reroute_fails = 0;
            occupied.insert(door);
            events.push(SimEvent::AgentStatus {
                agent_id: a.agent.id,
                status: STATUS_WALKING.into(),
            });
            events.push(SimEvent::AgentMoved {
                agent_id: a.agent.id,
                x: door.0,
                y: door.1,
            });
        }

        // 3. Move walking agents one tile (roster order). `occupied` is
        //    updated as agents move, so within a tick no two agents ever
        //    settle on the same tile and a vacated tile becomes usable by
        //    later-processed agents in the same tick.
        for i in 0..self.agents.len() {
            if !self.agents[i].spawned || self.agents[i].agent.current_status != STATUS_WALKING {
                continue;
            }
            if self.agents[i].path.is_empty() {
                // Defensive: walking with no path — re-path to chair.
                let from = (self.agents[i].agent.pos_x, self.agents[i].agent.pos_y);
                let chair = self.agents[i].chair;
                if let Some(p) = astar(&self.grid, &HashSet::new(), from, chair) {
                    self.agents[i].path = p.into_iter().collect();
                }
                if self.agents[i].path.is_empty() {
                    continue;
                }
            }
            let next = *self.agents[i].path.front().expect("checked non-empty");
            if occupied.contains(&next) {
                self.agents[i].stall_ticks += 1;
                if self.agents[i].stall_ticks >= REROUTE_AFTER_TICKS {
                    let from = (self.agents[i].agent.pos_x, self.agents[i].agent.pos_y);
                    let chair = self.agents[i].chair;
                    let mut extra = occupied.clone();
                    extra.remove(&from);
                    if let Some(p) = astar(&self.grid, &extra, from, chair) {
                        self.agents[i].path = p.into_iter().collect();
                        self.agents[i].reroute_fails = 0;
                    } else {
                        // Keep the old path and wait (behavior unchanged:
                        // the chair may be only momentarily unreachable
                        // because of standing agents) — but count the
                        // consecutive failures and get LOUD once the
                        // streak says this is no longer momentary. The
                        // event mirrors the stuck_unreachable pattern in
                        // the spawn branch, except current_status stays
                        // "walking" so the wait/retry loop keeps running.
                        self.agents[i].reroute_fails += 1;
                        if self.agents[i]
                            .reroute_fails
                            .is_multiple_of(STUCK_REROUTE_STREAK)
                        {
                            events.push(SimEvent::AgentStatus {
                                agent_id: self.agents[i].agent.id,
                                status: "stuck_in_place".into(),
                            });
                        }
                    }
                    self.agents[i].stall_ticks = 0;
                }
                continue;
            }
            let a = &mut self.agents[i];
            occupied.remove(&(a.agent.pos_x, a.agent.pos_y));
            a.agent.pos_x = next.0;
            a.agent.pos_y = next.1;
            occupied.insert(next);
            a.path.pop_front();
            a.stall_ticks = 0;
            a.reroute_fails = 0;
            events.push(SimEvent::AgentMoved {
                agent_id: a.agent.id,
                x: next.0,
                y: next.1,
            });
            if a.path.is_empty() && (a.agent.pos_x, a.agent.pos_y) == a.chair {
                a.agent.current_status = STATUS_SEATED.into();
                events.push(SimEvent::AgentStatus {
                    agent_id: a.agent.id,
                    status: STATUS_SEATED.into(),
                });
            }
        }

        // 4. Tick event last, so a client applying events in order ends
        //    the tick with a consistent clock.
        events.push(SimEvent::Tick {
            sim_day: self.world.sim_day,
            sim_clock_sec: self.world.sim_clock_sec,
            speed: self.speed,
        });
        events
    }

    /// Builds the 7.4 `world_snapshot` message (snake_case). The runtime
    /// `speed` rides inside `world` so a reconnecting client restores its
    /// speed selector too.
    pub fn snapshot_json(&self) -> serde_json::Value {
        let mut world = serde_json::to_value(&self.world).expect("world serializes");
        world["speed"] = json!(self.speed);
        json!({
            "type": "world_snapshot",
            "world": world,
            "agents": self.agents.iter().map(|a| &a.agent).collect::<Vec<_>>(),
            "layout": self.layout,
            "work_items": self.work_items,
        })
    }

    pub fn agent_by_id(&self, id: Uuid) -> Option<&AgentSim> {
        self.agents.iter().find(|a| a.agent.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::load_world_state_from_fixture_files;

    fn fixture_world() -> WorldState {
        load_world_state_from_fixture_files().expect("fixture world loads")
    }

    #[test]
    fn paused_world_does_not_advance() {
        let mut ws = fixture_world();
        assert_eq!(ws.world.status, WorldStatus::Paused);
        let clock_before = ws.world.sim_clock_sec;
        let events = ws.step();
        assert!(events.is_empty(), "paused step emits nothing");
        assert_eq!(ws.world.sim_clock_sec, clock_before);
    }

    #[test]
    fn running_step_advances_sec_per_tick_and_emits_tick() {
        let mut ws = fixture_world();
        ws.resume();
        let clock_before = ws.world.sim_clock_sec;
        let events = ws.step();
        assert_eq!(ws.world.sim_clock_sec, clock_before + ws.world.sec_per_tick);
        match events.last() {
            Some(SimEvent::Tick {
                sim_clock_sec,
                speed,
                ..
            }) => {
                assert_eq!(*sim_clock_sec, ws.world.sim_clock_sec);
                assert_eq!(*speed, 1);
            }
            other => panic!("last event must be Tick, got {other:?}"),
        }
    }

    #[test]
    fn set_speed_validates_allowed_values() {
        let mut ws = fixture_world();
        assert!(ws.set_speed(2).is_ok());
        assert_eq!(ws.speed, 2);
        assert!(ws.set_speed(5).is_ok());
        assert!(ws.set_speed(1).is_ok());
        assert!(ws.set_speed(3).is_err(), "x3 is not a spec speed");
        assert!(ws.set_speed(0).is_err());
        assert_eq!(ws.speed, 1, "failed set_speed must not change speed");
    }

    #[test]
    fn pause_resume_round_trip() {
        let mut ws = fixture_world();
        ws.resume();
        assert_eq!(ws.world.status, WorldStatus::Running);
        ws.pause();
        assert_eq!(ws.world.status, WorldStatus::Paused);
        ws.resume();
        assert_eq!(ws.world.status, WorldStatus::Running);
    }

    #[test]
    fn day_rolls_over_at_midnight() {
        let mut ws = fixture_world();
        ws.resume();
        ws.world.sim_clock_sec = crate::clock::DAY_SECS - ws.world.sec_per_tick;
        let day_before = ws.world.sim_day;
        ws.step();
        assert_eq!(ws.world.sim_day, day_before + 1);
        assert_eq!(ws.world.sim_clock_sec, 0);
    }

    #[test]
    fn snapshot_has_spec_74_shape() {
        let ws = fixture_world();
        let snap = ws.snapshot_json();
        assert_eq!(snap["type"], "world_snapshot");
        assert_eq!(snap["agents"].as_array().unwrap().len(), 9);
        assert_eq!(snap["layout"].as_array().unwrap().len(), 94);
        assert_eq!(snap["work_items"].as_array().unwrap().len(), 6);
        assert_eq!(snap["world"]["speed"], 1);
        assert_eq!(snap["world"]["sim_clock_sec"], 25200);
        // snake_case field spot checks on nested objects.
        let agent0 = &snap["agents"][0];
        assert!(agent0.get("sprite_key").is_some());
        assert!(agent0.get("current_status").is_some());
        let layout0 = &snap["layout"][0];
        assert!(layout0.get("pos_x").is_some());
        assert!(layout0.get("walkable").is_some());
    }

    #[test]
    fn kickoff_has_nobody_on_the_floor() {
        let ws = fixture_world();
        assert!(
            ws.agents
                .iter()
                .all(|a| !a.spawned && a.agent.current_status == STATUS_COMMUTING),
            "07:00 kickoff: everyone still commuting (spec T1.5)"
        );
    }

    // ---- Minor #2 regression tests -------------------------------------

    /// A tiny standalone tmj (ring of walls, one door) for tests that
    /// build a `WorldState` from scratch instead of the real fixture.
    fn tiny_tmj() -> String {
        let (w, h) = (6, 6);
        let mut walls = vec![0i64; w * h];
        for y in 0..h {
            for x in 0..w {
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    walls[y * w + x] = 2;
                }
            }
        }
        walls[(h - 1) * w + w / 2] = 0; // door, bottom center
        serde_json::json!({
            "width": w, "height": h,
            "layers": [{"type": "tilelayer", "name": "walls", "data": walls}],
            "tilesets": [{"firstgid": 1, "tiles": [
                {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
            ]}]
        })
        .to_string()
    }

    fn tiny_world() -> World {
        World {
            id: Uuid::nil(),
            name: "t".into(),
            seed: 1,
            sim_day: 1,
            sim_clock_sec: crate::clock::game_secs(7, 0),
            tick_ms: 1000,
            sec_per_tick: 10,
            status: WorldStatus::Paused,
        }
    }

    fn tiny_agent(name: &str, desk_id: Uuid) -> Agent {
        Agent {
            id: Uuid::new_v4(),
            world_id: Uuid::nil(),
            name: name.into(),
            sprite_key: "agent_x".into(),
            grade: "專員".into(),
            title: "t".into(),
            reports_to: None,
            core_identity: "t".into(),
            seed_traits: "t".into(),
            current_status: STATUS_COMMUTING.into(),
            pos_x: 0,
            pos_y: 0,
            desk_id: Some(desk_id),
            llm_profile: serde_json::json!({}),
        }
    }

    fn tiny_layout_item(
        id: Uuid,
        kind: crate::LayoutItemKind,
        key: &str,
        x: i32,
        y: i32,
        walkable: bool,
    ) -> LayoutItem {
        LayoutItem {
            id,
            world_id: Uuid::nil(),
            kind,
            key: key.into(),
            name: key.into(),
            pos_x: x,
            pos_y: y,
            w: 1,
            h: 1,
            rotation: 0,
            zone: "common".into(),
            walkable,
            affords: vec![],
            meta: serde_json::Value::Null,
        }
    }

    #[test]
    fn from_parts_rejects_two_agents_on_the_same_chair() {
        let desk_id = Uuid::new_v4();
        let layout = vec![
            tiny_layout_item(desk_id, crate::LayoutItemKind::Desk, "deskA", 2, 2, false),
            tiny_layout_item(
                Uuid::new_v4(),
                crate::LayoutItemKind::Chair,
                "deskA-chair",
                2,
                3,
                true,
            ),
        ];
        // Both agents point at the SAME desk_id, so both resolve to
        // "deskA-chair" — a one-to-one assignment violation.
        let agents = vec![tiny_agent("甲", desk_id), tiny_agent("乙", desk_id)];
        let err = WorldState::from_parts(tiny_world(), agents, layout, vec![], &tiny_tmj())
            .expect_err("duplicate chair assignment must be a loud error");
        assert!(
            err.contains("deskA-chair") && err.contains("one-to-one"),
            "error should name the offending chair and explain the rule: {err}"
        );
    }

    /// Reroute-failure streak: a walker whose chair's ONLY approach tile
    /// is permanently occupied by a seated agent keeps failing the
    /// wait-then-reroute A* re-run. After [`STUCK_REROUTE_STREAK`]
    /// consecutive failures a loud `stuck_in_place` event must fire, and
    /// the wait/retry behavior itself must be unchanged (the walker stays
    /// "walking"; it is never demoted to stuck_unreachable).
    ///
    /// Map (6x6 ring, door at (3,5)); interior x,y in 1..=4:
    ///   (1,1) = walker's chair; its neighbors are wall (0,1)/(1,0),
    ///           desk (2,1) non-walkable, and (1,2) — the only approach.
    ///   (1,2) = blocker's chair (walkable, but occupied once seated).
    ///   (2,2) = blocker's desk (non-walkable).
    #[test]
    fn reroute_fail_streak_emits_loud_stuck_event_and_keeps_waiting() {
        let walker_desk = Uuid::new_v4();
        let blocker_desk = Uuid::new_v4();
        let layout = vec![
            tiny_layout_item(
                walker_desk,
                crate::LayoutItemKind::Desk,
                "deskA",
                2,
                1,
                false,
            ),
            tiny_layout_item(
                Uuid::new_v4(),
                crate::LayoutItemKind::Chair,
                "deskA-chair",
                1,
                1,
                true,
            ),
            tiny_layout_item(
                blocker_desk,
                crate::LayoutItemKind::Desk,
                "deskB",
                2,
                2,
                false,
            ),
            tiny_layout_item(
                Uuid::new_v4(),
                crate::LayoutItemKind::Chair,
                "deskB-chair",
                1,
                2,
                true,
            ),
        ];
        // Sorted roster order: "blocker" < "walker".
        let agents = vec![
            tiny_agent("walker", walker_desk),
            tiny_agent("blocker", blocker_desk),
        ];
        let mut ws = WorldState::from_parts(tiny_world(), agents, layout, vec![], &tiny_tmj())
            .expect("valid two-agent world");
        assert_eq!(ws.agents[0].agent.name, "blocker");
        let walker_id = ws.agents[1].agent.id;
        // Blocker spawns first and sits down on the choke tile (1,2);
        // walker spawns after the blocker is guaranteed seated.
        let clock = ws.world.sim_clock_sec;
        ws.agents[0].spawn_sec = clock + 10;
        ws.agents[1].spawn_sec = clock + 150;
        ws.resume();

        let mut stuck_events = 0u32;
        // Enough ticks for: blocker seat (~6) + walker spawn (15) + walk
        // (~6) + STUCK_REROUTE_STREAK failed cycles of REROUTE_AFTER_TICKS
        // ticks each (100), with slack.
        for _ in 0..220 {
            for ev in ws.step() {
                if let SimEvent::AgentStatus { agent_id, status } = ev {
                    if status == "stuck_in_place" {
                        assert_eq!(agent_id, walker_id, "only the walker can be stuck");
                        stuck_events += 1;
                    }
                    assert_ne!(
                        status, "stuck_unreachable",
                        "a blocked-by-agent walker must keep waiting, not be marked unreachable"
                    );
                }
            }
        }
        assert!(
            stuck_events >= 1,
            "expected a loud stuck_in_place event after {STUCK_REROUTE_STREAK} consecutive reroute failures"
        );
        assert_eq!(
            ws.agents[0].agent.current_status, STATUS_SEATED,
            "blocker sits normally"
        );
        assert_eq!(
            ws.agents[1].agent.current_status, STATUS_WALKING,
            "walker keeps waiting/retrying (behavior unchanged by the loud event)"
        );
        assert!(
            ws.agents[1].reroute_fails >= STUCK_REROUTE_STREAK,
            "streak counter reflects the sustained failure"
        );
    }
}
