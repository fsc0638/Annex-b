//! Appendix A.2 commute schedule (Phase 1 T1.5 world script).
//!
//! "副總 08:20 到、經理 08:30、高級專員 08:40、專員 08:40–08:55 錯開、
//! 約聘 08:30（新人早到）" — in Phase 1 (no LLM cognition yet) this is an
//! engine-side schedule; from Phase 2 on it only seeds the day-1
//! daily_plan prompt (A.2: 非硬性).
//!
//! Determinism: specialists (grade 專員) are staggered 08:43/08:46/08:49/
//! 08:52/08:55 in byte-wise (Unicode code point) order of their names, so
//! the schedule is independent of DB row order vs fixture order.

use uuid::Uuid;

use crate::clock::game_secs;
use crate::Agent;

#[derive(Debug, Clone, PartialEq)]
pub struct CommuteEntry {
    pub agent_id: Uuid,
    /// Game clock (seconds since 00:00) at which the agent appears at the
    /// door and starts walking to their seat.
    pub spawn_sec: i32,
}

/// Builds the Appendix A.2 commute schedule for the given roster. Unknown
/// grades (none exist in the seed) fall back to 08:40 rather than
/// panicking. Returned in the same order as `agents`.
pub fn commute_schedule(agents: &[Agent]) -> Vec<CommuteEntry> {
    let mut specialists: Vec<&Agent> = agents.iter().filter(|a| a.grade == "專員").collect();
    specialists.sort_by(|a, b| a.name.cmp(&b.name));
    let stagger_of = |id: Uuid| -> Option<i32> {
        specialists
            .iter()
            .position(|a| a.id == id)
            .map(|i| game_secs(8, 43) + (i as i32) * 180)
    };

    agents
        .iter()
        .map(|a| {
            let spawn_sec = match a.grade.as_str() {
                "副總" => game_secs(8, 20),
                "經理" => game_secs(8, 30),
                "約聘" => game_secs(8, 30),
                "高級專員" => game_secs(8, 40),
                "專員" => stagger_of(a.id).unwrap_or_else(|| game_secs(8, 40)),
                _ => game_secs(8, 40),
            };
            CommuteEntry {
                agent_id: a.id,
                spawn_sec,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, grade: &str, n: u128) -> Agent {
        Agent {
            id: Uuid::from_u128(n),
            world_id: Uuid::nil(),
            name: name.into(),
            sprite_key: format!("agent_{n}"),
            grade: grade.into(),
            title: "t".into(),
            reports_to: None,
            core_identity: "c".into(),
            seed_traits: "s".into(),
            current_status: "commuting".into(),
            pos_x: 0,
            pos_y: 0,
            desk_id: None,
            llm_profile: serde_json::json!({}),
        }
    }

    fn roster() -> Vec<Agent> {
        vec![
            agent("方以寧", "副總", 1),
            agent("高子軒", "經理", 2),
            agent("沈書萍", "高級專員", 3),
            agent("郭立衡", "專員", 4),
            agent("曾若彤", "專員", 5),
            agent("韓致遠", "專員", 6),
            agent("廖苡安", "專員", 7),
            agent("江秉倫", "專員", 8),
            agent("阮曉青", "約聘", 9),
        ]
    }

    #[test]
    fn appendix_a2_fixed_times() {
        let agents = roster();
        let sched = commute_schedule(&agents);
        let by_name = |name: &str| {
            let a = agents.iter().find(|a| a.name == name).unwrap();
            sched.iter().find(|e| e.agent_id == a.id).unwrap().spawn_sec
        };
        assert_eq!(by_name("方以寧"), game_secs(8, 20), "VP arrives 08:20");
        assert_eq!(by_name("高子軒"), game_secs(8, 30), "manager 08:30");
        assert_eq!(by_name("沈書萍"), game_secs(8, 40), "senior 08:40");
        assert_eq!(
            by_name("阮曉青"),
            game_secs(8, 30),
            "temp staff early 08:30"
        );
    }

    #[test]
    fn specialists_staggered_inside_0840_0855_window_and_distinct() {
        let agents = roster();
        let sched = commute_schedule(&agents);
        let mut spec_times: Vec<i32> = agents
            .iter()
            .filter(|a| a.grade == "專員")
            .map(|a| sched.iter().find(|e| e.agent_id == a.id).unwrap().spawn_sec)
            .collect();
        assert_eq!(spec_times.len(), 5);
        for t in &spec_times {
            assert!(
                *t >= game_secs(8, 40) && *t <= game_secs(8, 55),
                "specialist spawn {t} outside 08:40-08:55"
            );
        }
        spec_times.sort();
        spec_times.dedup();
        assert_eq!(
            spec_times.len(),
            5,
            "specialist spawn times must be distinct"
        );
    }

    #[test]
    fn schedule_is_independent_of_roster_order() {
        let mut agents = roster();
        let sched_a = commute_schedule(&agents);
        agents.reverse();
        let sched_b = commute_schedule(&agents);
        for e in &sched_a {
            let other = sched_b.iter().find(|x| x.agent_id == e.agent_id).unwrap();
            assert_eq!(e.spawn_sec, other.spawn_sec);
        }
    }
}
