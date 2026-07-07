//! Tier routing table (spec 6.1): L0-L3 defaults come from env (model IDs
//! only, per user instruction "模型 ID 全放 env"); `agents.llm_profile` can
//! override L1-L3 per agent with a `"provider:model"` string. L0
//! (embedding/importance) is never overridable — pinned to local Ollama to
//! keep cost and vector space consistent (spec 6.1 v2.1 note).
//!
//! Timeout and retry-count are tier-level properties per the spec 6.1
//! table (L0=15s/2, L1=30s/2, L2=60s/2, L3=90s/1) and travel with the
//! resolved `TierTarget` regardless of whether `agents.llm_profile`
//! overrode the provider/model — an override only swaps
//! provider:model, never the tier's operational policy (spec 6.1: "覆寫只
//! 換供應商/型號，逾時、重試...規則不變").

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::provider::ProviderId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Tier {
    L0,
    L1,
    L2,
    L3,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::L0 => "L0",
            Tier::L1 => "L1",
            Tier::L2 => "L2",
            Tier::L3 => "L3",
        }
    }

    /// Whether `agents.llm_profile` may override this tier's default
    /// provider/model. Only L1/L2/L3 are overridable (spec 6.1 v2.1).
    pub fn is_overridable(&self) -> bool {
        !matches!(self, Tier::L0)
    }

    /// Tier-level timeout per spec 6.1's table. Fixed by tier, never by
    /// `llm_profile` override.
    pub fn timeout(&self) -> Duration {
        match self {
            Tier::L0 => Duration::from_secs(15),
            Tier::L1 => Duration::from_secs(30),
            Tier::L2 => Duration::from_secs(60),
            Tier::L3 => Duration::from_secs(90),
        }
    }

    /// Tier-level max retry count per spec 6.1's table. This is the number
    /// of *retries* after an initial attempt (e.g. L2's `2` means up to 3
    /// total attempts), matching the spec table's "重試" column, which is
    /// explicitly a retry count, not a total-attempts count.
    pub fn max_retries(&self) -> u32 {
        match self {
            Tier::L0 => 2,
            Tier::L1 => 2,
            Tier::L2 => 2,
            Tier::L3 => 1,
        }
    }
}

/// A resolved (provider, model) pair for a tier, plus the tier's timeout
/// and retry policy (spec 6.1) so callers never have to re-derive it from
/// the `Tier` separately after resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TierTarget {
    pub provider: ProviderId,
    pub model: String,
    pub timeout: Duration,
    pub max_retries: u32,
}

/// The tier -> default target table, built from env model IDs. Timeout and
/// retry-count are derived purely from `Tier` (spec 6.1's fixed table, see
/// `Tier::timeout`/`Tier::max_retries`) and attached to every `TierTarget`
/// this struct produces, so they always travel with tier resolution.
#[derive(Debug, Clone)]
pub struct TierDefaults {
    defaults: HashMap<Tier, TierTarget>,
}

impl TierDefaults {
    pub fn new() -> Self {
        TierDefaults {
            defaults: HashMap::new(),
        }
    }

    pub fn with_default(
        mut self,
        tier: Tier,
        provider: ProviderId,
        model: impl Into<String>,
    ) -> Self {
        self.defaults.insert(
            tier,
            TierTarget {
                provider,
                model: model.into(),
                timeout: tier.timeout(),
                max_retries: tier.max_retries(),
            },
        );
        self
    }

    pub fn get(&self, tier: Tier) -> Option<&TierTarget> {
        self.defaults.get(&tier)
    }

    /// Build tier defaults from environment variables. Spec 6.1 defaults:
    /// L0 = Ollama (embed + fast chat), L1 = Ollama qwen, L2 = Anthropic
    /// Haiku-class, L3 = Anthropic Sonnet-class. Env var names are chosen
    /// to be provider-explicit since v2.1 supports multiple providers per
    /// tier.
    pub fn from_env() -> Self {
        let get =
            |key: &str, fallback: &str| std::env::var(key).unwrap_or_else(|_| fallback.to_string());

        let l0_model = get("LLM_L0_MODEL", "qwen2.5:7b-instruct");
        let l1_model = get("LLM_L1_MODEL", "qwen2.5:7b-instruct");
        let l2_model = get("LLM_L2_MODEL", "claude-haiku-4-5");
        let l3_model = get("LLM_L3_MODEL", "claude-sonnet-4-5");

        let l2_provider = ProviderId::parse(&get("LLM_L2_PROVIDER", "anthropic"))
            .unwrap_or(ProviderId::Anthropic);
        let l3_provider = ProviderId::parse(&get("LLM_L3_PROVIDER", "anthropic"))
            .unwrap_or(ProviderId::Anthropic);

        TierDefaults::new()
            .with_default(Tier::L0, ProviderId::Ollama, l0_model)
            .with_default(Tier::L1, ProviderId::Ollama, l1_model)
            .with_default(Tier::L2, l2_provider, l2_model)
            .with_default(Tier::L3, l3_provider, l3_model)
    }
}

impl Default for TierDefaults {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the actual (provider, model) target for a given tier and agent,
/// applying `agents.llm_profile` override if present and the tier allows
/// it. Pure function over already-parsed inputs so it is unit-testable
/// without touching the DB or env.
///
/// `llm_profile` is expected to be a JSON object like
/// `{"L1": "openai:gpt-4o-mini", "L3": "gemini:gemini-2.5-pro"}`. Malformed
/// entries (missing colon, unknown provider) are ignored and the tier
/// default is used instead — this function never panics or errors on bad
/// profile data, matching the gateway's "fail toward default" posture.
pub fn resolve_tier_target(
    tier: Tier,
    defaults: &TierDefaults,
    llm_profile: &serde_json::Value,
) -> Option<TierTarget> {
    if tier.is_overridable() {
        if let Some(override_str) = llm_profile.get(tier.as_str()).and_then(|v| v.as_str()) {
            if let Some(target) = parse_override(tier, override_str) {
                return Some(target);
            }
            tracing::warn!(
                tier = tier.as_str(),
                override_str,
                "ignoring malformed llm_profile override, falling back to tier default"
            );
        }
    }
    defaults.get(tier).cloned()
}

/// Parses a `"provider:model"` override string. Returns `None` on
/// malformed input (no colon, or unknown provider prefix) rather than
/// erroring, so callers can decide fallback behavior. `timeout`/
/// `max_retries` on the returned target always come from `tier` itself
/// (spec 6.1: an override only swaps provider:model, never the tier's
/// timeout/retry policy) — never from anything override-string-derived.
fn parse_override(tier: Tier, s: &str) -> Option<TierTarget> {
    let (provider_str, model) = s.split_once(':')?;
    let provider = ProviderId::parse(provider_str)?;
    if model.is_empty() {
        return None;
    }
    Some(TierTarget {
        provider,
        model: model.to_string(),
        timeout: tier.timeout(),
        max_retries: tier.max_retries(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_defaults() -> TierDefaults {
        TierDefaults::new()
            .with_default(Tier::L0, ProviderId::Ollama, "mxbai-embed-large")
            .with_default(Tier::L1, ProviderId::Ollama, "qwen2.5:7b-instruct")
            .with_default(Tier::L2, ProviderId::Anthropic, "claude-haiku-4-5")
            .with_default(Tier::L3, ProviderId::Anthropic, "claude-sonnet-4-5")
    }

    #[test]
    fn empty_profile_uses_tier_default() {
        let defaults = sample_defaults();
        let empty = json!({});
        let target = resolve_tier_target(Tier::L2, &defaults, &empty).unwrap();
        assert_eq!(target.provider, ProviderId::Anthropic);
        assert_eq!(target.model, "claude-haiku-4-5");
    }

    #[test]
    fn l1_override_applies() {
        let defaults = sample_defaults();
        let profile = json!({"L1": "openai:gpt-4o-mini"});
        let target = resolve_tier_target(Tier::L1, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Openai);
        assert_eq!(target.model, "gpt-4o-mini");
    }

    #[test]
    fn l3_override_applies() {
        let defaults = sample_defaults();
        let profile = json!({"L3": "gemini:gemini-2.5-pro"});
        let target = resolve_tier_target(Tier::L3, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Gemini);
        assert_eq!(target.model, "gemini-2.5-pro");
    }

    #[test]
    fn l0_override_is_ignored_even_if_present() {
        let defaults = sample_defaults();
        // Even if a profile mistakenly sets L0, it must never apply.
        let profile = json!({"L0": "openai:text-embedding-3-small"});
        let target = resolve_tier_target(Tier::L0, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Ollama);
        assert_eq!(target.model, "mxbai-embed-large");
    }

    #[test]
    fn malformed_override_falls_back_to_default() {
        let defaults = sample_defaults();
        let profile = json!({"L2": "not-a-valid-format"});
        let target = resolve_tier_target(Tier::L2, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Anthropic);
        assert_eq!(target.model, "claude-haiku-4-5");
    }

    #[test]
    fn unknown_provider_in_override_falls_back_to_default() {
        let defaults = sample_defaults();
        let profile = json!({"L2": "unknownprovider:some-model"});
        let target = resolve_tier_target(Tier::L2, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Anthropic);
    }

    #[test]
    fn empty_model_in_override_falls_back_to_default() {
        let defaults = sample_defaults();
        let profile = json!({"L2": "openai:"});
        let target = resolve_tier_target(Tier::L2, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Anthropic);
    }

    #[test]
    fn parse_override_handles_model_names_with_colons() {
        // Some model ids don't have colons, but be defensive: split_once
        // splits on the FIRST colon only, so "ollama:qwen2.5:7b-instruct"
        // should parse as provider=ollama, model="qwen2.5:7b-instruct".
        let target = parse_override(Tier::L1, "ollama:qwen2.5:7b-instruct").unwrap();
        assert_eq!(target.provider, ProviderId::Ollama);
        assert_eq!(target.model, "qwen2.5:7b-instruct");
    }

    // --- spec 6.1 timeout/retry table -------------------------------

    #[test]
    fn l0_timeout_and_retries_match_spec_table() {
        assert_eq!(Tier::L0.timeout(), Duration::from_secs(15));
        assert_eq!(Tier::L0.max_retries(), 2);
    }

    #[test]
    fn l1_timeout_and_retries_match_spec_table() {
        assert_eq!(Tier::L1.timeout(), Duration::from_secs(30));
        assert_eq!(Tier::L1.max_retries(), 2);
    }

    #[test]
    fn l2_timeout_and_retries_match_spec_table() {
        assert_eq!(Tier::L2.timeout(), Duration::from_secs(60));
        assert_eq!(Tier::L2.max_retries(), 2);
    }

    #[test]
    fn l3_timeout_and_retries_match_spec_table() {
        assert_eq!(Tier::L3.timeout(), Duration::from_secs(90));
        assert_eq!(Tier::L3.max_retries(), 1);
    }

    #[test]
    fn resolved_default_target_carries_tier_timeout_and_retries() {
        let defaults = sample_defaults();
        let empty = json!({});
        let l2 = resolve_tier_target(Tier::L2, &defaults, &empty).unwrap();
        assert_eq!(l2.timeout, Duration::from_secs(60));
        assert_eq!(l2.max_retries, 2);
        let l3 = resolve_tier_target(Tier::L3, &defaults, &empty).unwrap();
        assert_eq!(l3.timeout, Duration::from_secs(90));
        assert_eq!(l3.max_retries, 1);
    }

    #[test]
    fn llm_profile_override_keeps_tier_timeout_and_retries_unchanged() {
        // Spec 6.1: "覆寫只換供應商/型號，逾時、重試...規則不變" — an
        // override to a different provider/model on L2 must still carry
        // L2's own timeout/retry policy, not some override-derived value.
        let defaults = sample_defaults();
        let profile = json!({"L2": "openai:gpt-4o-mini"});
        let target = resolve_tier_target(Tier::L2, &defaults, &profile).unwrap();
        assert_eq!(target.provider, ProviderId::Openai);
        assert_eq!(target.timeout, Duration::from_secs(60));
        assert_eq!(target.max_retries, 2);
    }
}
