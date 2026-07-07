//! Pricing table and cost calculation (spec 6.1: "pricing.toml 收錄三家常見
//!型號單價...+計價純函數"). Prices are per-million-tokens in USD, matching
//! how the major providers publish rate cards. This module's numbers are a
//! snapshot for cost estimation, NOT a billing source of truth — see the
//! header comment embedded in `pricing.toml` at the repo root.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct ModelPrice {
    /// USD per 1,000,000 input tokens.
    pub input_per_million: f64,
    /// USD per 1,000,000 output tokens.
    pub output_per_million: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PricingTable {
    #[serde(flatten)]
    pub models: HashMap<String, ModelPrice>,
}

impl PricingTable {
    pub fn load_from_str(toml_str: &str) -> anyhow::Result<Self> {
        let table: PricingTable = toml::from_str(toml_str)?;
        Ok(table)
    }

    pub fn load_from_file(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Self::load_from_str(&content)
    }

    /// Looks up a price by `"provider:model"` key (matches the pricing.toml
    /// key convention and the llm_profile override format). A miss still
    /// returns `None` (callers, per `calculate_cost_usd`, account $0 cost
    /// for it — deliberately unchanged fail-toward-default behavior), but
    /// logs a warning naming the missed key so a misconfigured
    /// `llm_profile` override pointing at an unpriced model doesn't
    /// silently undercount spend against `DAILY_BUDGET_USD` with zero
    /// operator-visible signal (Minor #4 fix).
    pub fn get(&self, provider: &str, model: &str) -> Option<&ModelPrice> {
        let key = format!("{provider}:{model}");
        let price = self.models.get(&key);
        if price.is_none() {
            tracing::warn!(
                provider,
                model,
                "no pricing.toml entry for this provider:model — accounting $0 cost for this call"
            );
        }
        price
    }
}

/// Pure cost calculation: given a price entry and token counts, returns
/// USD cost. Returns 0.0 for missing/None token counts (e.g. mock
/// provider calls that don't report usage) rather than erroring, so
/// callers can always compute a total.
pub fn calculate_cost_usd(
    price: Option<&ModelPrice>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
) -> f64 {
    let Some(price) = price else {
        return 0.0;
    };
    let input_cost = input_tokens.unwrap_or(0) as f64 / 1_000_000.0 * price.input_per_million;
    let output_cost = output_tokens.unwrap_or(0) as f64 / 1_000_000.0 * price.output_per_million;
    input_cost + output_cost
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_price() -> ModelPrice {
        ModelPrice {
            input_per_million: 3.0,
            output_per_million: 15.0,
        }
    }

    #[test]
    fn calculates_cost_from_tokens() {
        let price = sample_price();
        let cost = calculate_cost_usd(Some(&price), Some(1_000_000), Some(1_000_000));
        assert!((cost - 18.0).abs() < 1e-9);
    }

    #[test]
    fn zero_tokens_is_zero_cost() {
        let price = sample_price();
        let cost = calculate_cost_usd(Some(&price), Some(0), Some(0));
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn missing_price_is_zero_cost() {
        let cost = calculate_cost_usd(None, Some(1000), Some(1000));
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn none_token_counts_treated_as_zero() {
        let price = sample_price();
        let cost = calculate_cost_usd(Some(&price), None, None);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn load_from_str_parses_toml_and_looks_up_by_provider_model_key() {
        let toml_str = r#"
["anthropic:claude-haiku-4-5"]
input_per_million = 1.0
output_per_million = 5.0

["openai:gpt-4o-mini"]
input_per_million = 0.15
output_per_million = 0.6
"#;
        let table = PricingTable::load_from_str(toml_str).unwrap();
        let price = table.get("anthropic", "claude-haiku-4-5").unwrap();
        assert_eq!(price.input_per_million, 1.0);
        let missing = table.get("anthropic", "does-not-exist");
        assert!(missing.is_none());
    }

    #[test]
    fn get_on_unpriced_model_still_returns_none_and_composes_to_zero_cost() {
        // Minor #4 fix: a miss now also emits a tracing::warn (not
        // asserted here — no subscriber wired in this unit test — but the
        // $0-cost behavior itself must be unchanged end-to-end: a
        // misconfigured llm_profile override pointing at an unpriced
        // model still accounts $0, it's just no longer silent to an
        // operator watching logs).
        let table = PricingTable::load_from_str(
            r#"
["openai:gpt-4.1-mini"]
input_per_million = 0.4
output_per_million = 1.6
"#,
        )
        .unwrap();
        let price = table.get("openai:gpt-4.1-mini-override", "unpriced-model");
        assert!(price.is_none());
        let cost = calculate_cost_usd(price, Some(1_000_000), Some(1_000_000));
        assert_eq!(cost, 0.0);
    }
}
