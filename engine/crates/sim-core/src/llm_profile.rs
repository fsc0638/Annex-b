//! Shared validation for `agents.llm_profile` overrides (ADR-002 D5).
//!
//! `llm_profile` is a sim-core domain field (`Agent::llm_profile`), so the
//! single source of truth for "what is a valid override object" lives here,
//! next to the type. Both entry points that accept user/save-file data call
//! [`validate_llm_profile`]:
//! - api-server's `PATCH /api/v1/agents/:id` handler (maps the `Err`
//!   message into its 422 JSON envelope), and
//! - the fixture-mode persist load path (`persist::apply_save_file`), which
//!   previously skipped this check entirely — a hand-edited save file could
//!   resurrect an `llm_profile` the API layer would have rejected.
//!
//! Rules (spec 6.1 v2.1): the value must be a JSON object; every key must be
//! one of `L1`/`L2`/`L3` (`L0` is pinned and never overridable); every value
//! must be a `"provider:model"` string with a known provider and a non-empty
//! model. Unlike `llm_gateway::tier::resolve_tier_target` (which silently
//! falls back to the tier default on malformed input, appropriate for a hot
//! runtime path), this is a validation gate for externally-supplied data —
//! malformed input here is a loud error, not a silent fallback.

use serde_json::Value;

/// Canonical provider identifiers accepted in a `"provider:model"` override
/// string. Mirrors `llm_gateway::provider::ProviderId` (sim-core is a pure,
/// I/O-light crate and deliberately does not depend on llm-gateway, so the
/// closed set is restated here). If a provider is added to `ProviderId`, add
/// it here too — the two must stay in sync.
const KNOWN_PROVIDERS: &[&str] = &["anthropic", "openai", "gemini", "ollama", "mock"];

/// Validates one `llm_profile` value. Returns a human-readable error message
/// on the first rule violation (the api-server handler wraps it into a 422
/// envelope; the persist load path logs it as a WARN and clears just that
/// agent's override).
pub fn validate_llm_profile(v: &Value) -> Result<(), String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "llm_profile must be a JSON object".to_string())?;
    for (key, val) in obj {
        match key.as_str() {
            "L1" | "L2" | "L3" => {}
            "L0" => {
                return Err(
                    "llm_profile must not override L0 (spec 6.1: L0 is pinned, never overridable)"
                        .to_string(),
                )
            }
            other => {
                return Err(format!(
                    "llm_profile: unknown tier key '{other}' (allowed: L1, L2, L3)"
                ))
            }
        }
        let s = val
            .as_str()
            .ok_or_else(|| format!("llm_profile.{key} must be a string"))?;
        let (provider, model) = s.split_once(':').ok_or_else(|| {
            format!("llm_profile.{key} must be formatted as \"provider:model\", got '{s}'")
        })?;
        if !KNOWN_PROVIDERS.contains(&provider) {
            return Err(format!("llm_profile.{key}: unknown provider '{provider}'"));
        }
        if model.is_empty() {
            return Err(format!("llm_profile.{key}: model must not be empty"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_empty_and_valid_overrides() {
        assert!(validate_llm_profile(&json!({})).is_ok());
        assert!(validate_llm_profile(&json!({"L1": "openai:gpt-4o-mini"})).is_ok());
        assert!(validate_llm_profile(&json!({
            "L2": "anthropic:claude-haiku-4-5",
            "L3": "gemini:gemini-2.5-pro"
        }))
        .is_ok());
    }

    #[test]
    fn rejects_l0_override() {
        assert!(
            validate_llm_profile(&json!({"L0": "ollama:mxbai-embed-large"}))
                .unwrap_err()
                .contains("L0")
        );
    }

    #[test]
    fn rejects_unknown_tier_key() {
        assert!(validate_llm_profile(&json!({"L4": "openai:gpt-4o"}))
            .unwrap_err()
            .contains("L4"));
    }

    #[test]
    fn rejects_missing_colon_unknown_provider_and_empty_model() {
        assert!(validate_llm_profile(&json!({"L1": "gpt-4o-mini"}))
            .unwrap_err()
            .contains("provider:model"));
        assert!(
            validate_llm_profile(&json!({"L1": "notaprovider:some-model"}))
                .unwrap_err()
                .contains("unknown provider")
        );
        assert!(validate_llm_profile(&json!({"L1": "openai:"}))
            .unwrap_err()
            .contains("model must not be empty"));
    }

    #[test]
    fn rejects_non_object() {
        assert!(validate_llm_profile(&json!("not-an-object")).is_err());
        assert!(validate_llm_profile(&json!(["L1", "openai:gpt-4o"])).is_err());
    }
}
