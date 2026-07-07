//! Headless commute integration test (Phase 1 T1.5 / acceptance B).
//!
//! Loads the world purely from fixture + tmj (no DB), runs the tick loop
//! synchronously to game time 09:30, and asserts the full Phase 1
//! acceptance surface:
//!   - 07:00 kickoff: nobody on the floor;
//!   - agents spawn at the door at their Appendix A.2 times;
//!   - all 9 end up seated on their OWN chair;
//!   - at no tick do two agents share a tile;
//!   - nobody ever stands on a non-walkable tile;
//!   - no agent goes >60 consecutive ticks without progress;
//!   - per-agent status event sequence is exactly walking -> seated
//!     (starting from the seeded 'commuting').

use std::collections::{HashMap, HashSet};

use sim_core::clock::game_secs;
use sim_core::events::SimEvent;
use sim_core::fixture::load_world_state_from_fixture_files;
use sim_core::world::{STATUS_COMMUTING, STATUS_SEATED};
use uuid::Uuid;

#[test]
fn commute_headless_all_nine_seated_by_0930() {
    let mut ws = load_world_state_from_fixture_files().expect("fixture world");
    assert_eq!(ws.world.sim_clock_sec, game_secs(7, 0), "07:00 kickoff");
    assert!(
        ws.agents
            .iter()
            .all(|a| !a.spawned && a.agent.current_status == STATUS_COMMUTING),
        "kickoff: floor must be empty"
    );

    ws.resume();

    let mut last_pos: HashMap<Uuid, (i32, i32)> = HashMap::new();
    let mut no_progress_ticks: HashMap<Uuid, u32> = HashMap::new();
    let mut max_no_progress: u32 = 0;
    let mut status_events: HashMap<Uuid, Vec<String>> = HashMap::new();
    let mut spawn_clock: HashMap<Uuid, i32> = HashMap::new();
    let mut ticks = 0u32;

    while ws.world.sim_clock_sec < game_secs(9, 30) {
        let clock_before_events = ws.world.sim_clock_sec;
        let events = ws.step();
        ticks += 1;
        assert!(ticks < 2000, "runaway loop: clock not advancing?");

        for ev in &events {
            if let SimEvent::AgentStatus { agent_id, status } = ev {
                status_events
                    .entry(*agent_id)
                    .or_default()
                    .push(status.clone());
                if status == "walking" {
                    spawn_clock.insert(*agent_id, ws.world.sim_clock_sec);
                }
            }
        }

        // Invariant: no two on-floor agents share a tile; nobody stands on
        // a blocked (non-walkable) tile.
        let mut occupied: HashSet<(i32, i32)> = HashSet::new();
        for a in &ws.agents {
            if !a.spawned {
                continue;
            }
            let pos = (a.agent.pos_x, a.agent.pos_y);
            assert!(
                occupied.insert(pos),
                "tick@{}: two agents on tile {:?}",
                clock_before_events,
                pos
            );
            assert!(
                !ws.grid.is_blocked(pos.0, pos.1),
                "tick@{}: {} standing on blocked tile {:?}",
                clock_before_events,
                a.agent.name,
                pos
            );
        }

        // Stuck detection: walking agents must make positional progress at
        // least once every 60 ticks.
        for a in &ws.agents {
            if !a.spawned || a.agent.current_status != "walking" {
                no_progress_ticks.remove(&a.agent.id);
                continue;
            }
            let pos = (a.agent.pos_x, a.agent.pos_y);
            let counter = no_progress_ticks.entry(a.agent.id).or_insert(0);
            if last_pos.get(&a.agent.id) == Some(&pos) {
                *counter += 1;
            } else {
                *counter = 0;
            }
            max_no_progress = max_no_progress.max(*counter);
            assert!(
                *counter < 60,
                "{} stuck for 60 ticks at {:?}",
                a.agent.name,
                pos
            );
        }
        for a in &ws.agents {
            if a.spawned {
                last_pos.insert(a.agent.id, (a.agent.pos_x, a.agent.pos_y));
            }
        }
    }

    // Final state: all 9 seated on their own chair.
    assert_eq!(ws.agents.len(), 9);
    for a in &ws.agents {
        assert_eq!(
            a.agent.current_status, STATUS_SEATED,
            "{} must be seated by 09:30",
            a.agent.name
        );
        assert_eq!(
            (a.agent.pos_x, a.agent.pos_y),
            a.chair,
            "{} must sit on their own chair",
            a.agent.name
        );
    }

    // Status event sequence per agent: exactly [walking, seated].
    for a in &ws.agents {
        let seq = status_events
            .get(&a.agent.id)
            .unwrap_or_else(|| panic!("{} emitted no status events", a.agent.name));
        assert_eq!(
            seq,
            &vec!["walking".to_string(), "seated".to_string()],
            "{} status sequence",
            a.agent.name
        );
    }

    // Spawn times: first 'walking' event lands exactly on the first tick
    // at/after the Appendix A.2 spawn second (tick granularity = 10 game
    // seconds; every A.2 time is a multiple of 10, so equality holds
    // unless the doorway was crowded, which allows a small slip).
    for a in &ws.agents {
        let seen = spawn_clock[&a.agent.id];
        assert!(
            seen >= a.spawn_sec && seen <= a.spawn_sec + 60,
            "{} spawned at {} but was scheduled {}",
            a.agent.name,
            seen,
            a.spawn_sec
        );
    }

    println!(
        "commute_headless: 9/9 seated by 09:30; ticks={ticks}; max_no_progress_ticks={max_no_progress}"
    );
}

/// The same run at x5 speed setting must behave identically per tick
/// (speed only shortens the WALL-clock interval, which a headless loop
/// doesn't wait on anyway) — guards the speed semantics.
#[test]
fn speed_multiplier_does_not_change_per_tick_behavior() {
    let mut a = load_world_state_from_fixture_files().unwrap();
    let mut b = load_world_state_from_fixture_files().unwrap();
    a.resume();
    b.resume();
    b.set_speed(5).unwrap();
    for _ in 0..400 {
        let ea = a.step();
        let eb = b.step();
        // Events must be identical except the speed field inside Tick.
        assert_eq!(ea.len(), eb.len());
        for (x, y) in ea.iter().zip(eb.iter()) {
            match (x, y) {
                (
                    SimEvent::Tick {
                        sim_day: d1,
                        sim_clock_sec: c1,
                        ..
                    },
                    SimEvent::Tick {
                        sim_day: d2,
                        sim_clock_sec: c2,
                        ..
                    },
                ) => {
                    assert_eq!((d1, c1), (d2, c2));
                }
                (x, y) => assert_eq!(x, y),
            }
        }
    }
    for (x, y) in a.agents.iter().zip(b.agents.iter()) {
        assert_eq!(
            (x.agent.pos_x, x.agent.pos_y),
            (y.agent.pos_x, y.agent.pos_y)
        );
        assert_eq!(x.agent.current_status, y.agent.current_status);
    }
}
