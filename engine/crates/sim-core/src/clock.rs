//! Game-clock helpers (Phase 1 T1.2).
//!
//! `worlds` column semantics (001_init.sql): `tick_ms` is the wall-clock
//! interval between ticks at x1 speed; `sec_per_tick` is how many game
//! seconds each tick advances; `sim_clock_sec` is seconds since 00:00 game
//! time (25200 = 07:00 kickoff). Speed x2/x5 shortens the wall-clock
//! interval only — game seconds per tick (and thus agent movement per game
//! second) is unchanged, so faster speed means faster wall-clock playback
//! of the same world behavior.

pub const DAY_SECS: i32 = 86400;

/// Formats a game clock as "HH:MM" (UI shows 遊戲日＋時鐘).
pub fn hhmm(sim_clock_sec: i32) -> String {
    let s = sim_clock_sec.rem_euclid(DAY_SECS);
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

/// Game seconds since 00:00 for an H:M time of day.
pub const fn game_secs(hour: i32, minute: i32) -> i32 {
    hour * 3600 + minute * 60
}

/// Wall-clock milliseconds between ticks for a given speed multiplier.
/// Valid speeds are 1|2|5 (spec 7.1 time controls); enforced by
/// `WorldState::set_speed`, so this helper just guards division.
pub fn tick_interval_ms(tick_ms: i32, speed: u32) -> u64 {
    let base = tick_ms.max(1) as u64;
    let sp = speed.max(1) as u64;
    (base / sp).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hhmm_formats_kickoff_and_rollover() {
        assert_eq!(hhmm(25200), "07:00");
        assert_eq!(hhmm(30000), "08:20");
        assert_eq!(hhmm(32100), "08:55");
        assert_eq!(hhmm(0), "00:00");
        assert_eq!(hhmm(DAY_SECS - 60), "23:59");
        assert_eq!(hhmm(DAY_SECS + 60), "00:01");
    }

    #[test]
    fn game_secs_matches_appendix_a2_times() {
        assert_eq!(game_secs(7, 0), 25200);
        assert_eq!(game_secs(8, 20), 30000);
        assert_eq!(game_secs(8, 30), 30600);
        assert_eq!(game_secs(8, 40), 31200);
        assert_eq!(game_secs(8, 55), 32100);
        assert_eq!(game_secs(9, 30), 34200);
    }

    #[test]
    fn tick_interval_scales_with_speed() {
        assert_eq!(tick_interval_ms(1000, 1), 1000);
        assert_eq!(tick_interval_ms(1000, 2), 500);
        assert_eq!(tick_interval_ms(1000, 5), 200);
        // Guards: nonsense inputs never yield 0 (which would spin-loop).
        assert_eq!(tick_interval_ms(0, 1), 1);
        assert_eq!(tick_interval_ms(1000, 0), 1000);
    }
}
