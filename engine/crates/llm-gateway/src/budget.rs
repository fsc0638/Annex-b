//! Daily budget threshold logic (spec 6.1: "DAILY_BUDGET_USD... 80%/100%
//! 閾值判斷"). Phase 0 scope: read the env var and expose pure threshold
//! functions. Wiring this into the actual call loop (degrade at 80%, pause
//! at 100%) is Phase 2+ (the gateway needs a live spend total from
//! `llm_calls`, which requires the DB-backed pipeline).

use serde::{Deserialize, Serialize};

/// Default daily budget per spec 6.1 `[DEFAULT]`.
pub const DEFAULT_DAILY_BUDGET_USD: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetState {
    /// Spend is below the 80% warning threshold.
    Normal,
    /// Spend is at or above 80% but below 100% — gateway should degrade
    /// (e.g. skip non-essential L2/L3 calls) per spec.
    Degraded,
    /// Spend is at or above 100% — gateway should pause cloud calls.
    Paused,
}

/// Reads `DAILY_BUDGET_USD` from the environment, falling back to the spec
/// default (2.0) when unset or unparseable.
pub fn daily_budget_usd_from_env() -> f64 {
    std::env::var("DAILY_BUDGET_USD")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(DEFAULT_DAILY_BUDGET_USD)
}

/// Pure function: classify current spend against the daily budget.
/// `budget_usd <= 0.0` is treated as "no budget configured" and always
/// returns `Normal` (fail open rather than permanently pausing on
/// misconfiguration) — callers that want fail-closed behavior should
/// validate budget_usd before calling.
pub fn classify_budget_state(spend_usd: f64, budget_usd: f64) -> BudgetState {
    if budget_usd <= 0.0 {
        return BudgetState::Normal;
    }
    let ratio = spend_usd / budget_usd;
    if ratio >= 1.0 {
        BudgetState::Paused
    } else if ratio >= 0.8 {
        BudgetState::Degraded
    } else {
        BudgetState::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_80_percent_is_normal() {
        assert_eq!(classify_budget_state(1.0, 2.0), BudgetState::Normal);
    }

    #[test]
    fn exactly_80_percent_is_degraded() {
        assert_eq!(classify_budget_state(1.6, 2.0), BudgetState::Degraded);
    }

    #[test]
    fn between_80_and_100_is_degraded() {
        assert_eq!(classify_budget_state(1.9, 2.0), BudgetState::Degraded);
    }

    #[test]
    fn exactly_100_percent_is_paused() {
        assert_eq!(classify_budget_state(2.0, 2.0), BudgetState::Paused);
    }

    #[test]
    fn over_100_percent_is_paused() {
        assert_eq!(classify_budget_state(5.0, 2.0), BudgetState::Paused);
    }

    #[test]
    fn zero_budget_fails_open_to_normal() {
        assert_eq!(classify_budget_state(100.0, 0.0), BudgetState::Normal);
    }

    #[test]
    fn zero_spend_is_normal() {
        assert_eq!(classify_budget_state(0.0, 2.0), BudgetState::Normal);
    }
}
