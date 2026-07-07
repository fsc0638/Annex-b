//! llm-gateway: routing, queueing, metering, mock (spec section 6).
//!
//! Phase 0 scope (T0.4): provider trait + 5 implementations
//! (anthropic/openai/gemini/ollama/mock), tier routing table with
//! `agents.llm_profile` override, `LLM_MODE=mock` switch, `llm_calls`
//! metering via an injectable recorder, `pricing.toml` loading + pure cost
//! function, and `DAILY_BUDGET_USD` threshold functions.
//!
//! NOT in Phase 0: concurrency limiting, actual budget-driven degradation
//! wired into the call path, prompt hot-reload, queueing under load — these
//! land as agent-core/api-server grow in Phase 1-2 and consume this crate.

pub mod budget;
pub mod json_guard;
pub mod pricing;
pub mod provider;
pub mod providers;
pub mod recorder;
pub mod tier;

use std::collections::HashMap;
use std::sync::Arc;

use provider::{ChatProvider, ProviderId};
use providers::{
    anthropic::AnthropicProvider, gemini::GeminiProvider, mock::MockProvider,
    ollama::OllamaProvider, openai::OpenAiProvider,
};
use tier::TierDefaults;

/// Global LLM mode switch. `Mock` forces every chat call through the
/// deterministic mock provider regardless of tier routing — this is what
/// makes golden-replay tests (S6) possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmMode {
    Real,
    Mock,
}

impl LlmMode {
    pub fn from_env() -> Self {
        match std::env::var("LLM_MODE").as_deref() {
            Ok("mock") => LlmMode::Mock,
            _ => LlmMode::Real,
        }
    }
}

/// Per-provider enabled/disabled status, for `GET /api/v1/healthz`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderStatus {
    pub provider: String,
    pub enabled: bool,
}

/// The gateway: holds one instance of each provider plus tier defaults.
/// Construct once at process startup from env.
pub struct Gateway {
    pub mode: LlmMode,
    providers: HashMap<ProviderId, Arc<dyn ChatProvider>>,
    pub ollama: Arc<OllamaProvider>,
    pub tier_defaults: TierDefaults,
}

impl Gateway {
    /// Builds a gateway from environment variables:
    /// - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (absence
    ///   disables that provider)
    /// - `OLLAMA_BASE_URL` (default `http://localhost:11434`)
    /// - `LLM_MODE` (`mock` or unset/`real`)
    /// - `LLM_L{0,1,2,3}_MODEL`, `LLM_L{2,3}_PROVIDER` (tier defaults)
    pub fn from_env() -> Self {
        let anthropic = Arc::new(AnthropicProvider::new(
            std::env::var("ANTHROPIC_API_KEY").ok(),
        ));
        let openai = Arc::new(OpenAiProvider::new(std::env::var("OPENAI_API_KEY").ok()));
        let gemini = Arc::new(GeminiProvider::new(std::env::var("GEMINI_API_KEY").ok()));
        let ollama_base_url = std::env::var("OLLAMA_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:11434".to_string());
        let ollama = Arc::new(OllamaProvider::new(ollama_base_url));
        let mock = Arc::new(MockProvider::new());

        let mut providers: HashMap<ProviderId, Arc<dyn ChatProvider>> = HashMap::new();
        providers.insert(ProviderId::Anthropic, anthropic);
        providers.insert(ProviderId::Openai, openai);
        providers.insert(ProviderId::Gemini, gemini);
        providers.insert(ProviderId::Ollama, ollama.clone());
        providers.insert(ProviderId::Mock, mock);

        Gateway {
            mode: LlmMode::from_env(),
            providers,
            ollama,
            tier_defaults: TierDefaults::from_env(),
        }
    }

    /// Look up a provider by id. Returns `None` if the id is not registered
    /// (should not happen for the 5 canonical ids built in `from_env`).
    pub fn provider(&self, id: ProviderId) -> Option<Arc<dyn ChatProvider>> {
        self.providers.get(&id).cloned()
    }

    /// Resolve which provider to actually call for a tier + agent profile,
    /// honoring `LLM_MODE=mock` (which always wins) and the llm_profile
    /// override (spec 6.1 v2.1).
    pub fn resolve_provider_for_tier(
        &self,
        tier: tier::Tier,
        llm_profile: &serde_json::Value,
    ) -> Option<(Arc<dyn ChatProvider>, String)> {
        if self.mode == LlmMode::Mock {
            let model = self
                .tier_defaults
                .get(tier)
                .map(|t| t.model.clone())
                .unwrap_or_else(|| "mock-model".to_string());
            return self.provider(ProviderId::Mock).map(|p| (p, model));
        }
        let target = tier::resolve_tier_target(tier, &self.tier_defaults, llm_profile)?;
        self.provider(target.provider)
            .map(|p| (p, target.model.clone()))
    }

    /// Status of every provider for healthz reporting.
    pub fn provider_statuses(&self) -> Vec<ProviderStatus> {
        let mut ids = vec![
            ProviderId::Anthropic,
            ProviderId::Openai,
            ProviderId::Gemini,
            ProviderId::Ollama,
        ];
        ids.sort_by_key(|id| id.as_str());
        ids.into_iter()
            .filter_map(|id| {
                self.provider(id).map(|p| ProviderStatus {
                    provider: id.as_str().to_string(),
                    enabled: p.is_enabled(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `std::env::set_var`/`remove_var` are process-global, but `cargo test`
    // runs tests in this module concurrently on multiple threads within one
    // process. Any test that mutates env vars read by `from_env()` must hold
    // this lock for its full set/assert/unset span, or it will race other
    // such tests non-deterministically. Tests that only ever read env state
    // that nothing else here mutates (e.g. plain `Gateway::from_env()` with
    // no LLM_MODE dependency) don't need the lock.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn llm_mode_defaults_to_real_when_unset() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("LLM_MODE");
        assert_eq!(LlmMode::from_env(), LlmMode::Real);
    }

    #[test]
    fn llm_mode_mock_when_env_set() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("LLM_MODE", "mock");
        assert_eq!(LlmMode::from_env(), LlmMode::Mock);
        std::env::remove_var("LLM_MODE");
    }

    #[test]
    fn gateway_from_env_disables_providers_without_keys() {
        std::env::remove_var("ANTHROPIC_API_KEY");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("GEMINI_API_KEY");
        let gateway = Gateway::from_env();
        let statuses = gateway.provider_statuses();
        let anthropic = statuses.iter().find(|s| s.provider == "anthropic").unwrap();
        assert!(!anthropic.enabled);
    }

    #[test]
    fn gateway_provider_statuses_includes_four_cloud_and_local_providers() {
        let gateway = Gateway::from_env();
        let statuses = gateway.provider_statuses();
        let names: Vec<_> = statuses.iter().map(|s| s.provider.as_str()).collect();
        assert!(names.contains(&"anthropic"));
        assert!(names.contains(&"openai"));
        assert!(names.contains(&"gemini"));
        assert!(names.contains(&"ollama"));
        assert_eq!(statuses.len(), 4);
    }

    #[tokio::test]
    async fn mock_mode_always_resolves_to_mock_provider() {
        // Constructs the gateway directly in Mock mode instead of round-
        // tripping through the LLM_MODE env var, so this test cannot race
        // llm_mode_mock_when_env_set / llm_mode_defaults_to_real_when_unset
        // above even without the env mutex.
        let mut gateway = Gateway::from_env();
        gateway.mode = LlmMode::Mock;
        let profile = serde_json::json!({});
        let (provider, _model) = gateway
            .resolve_provider_for_tier(tier::Tier::L3, &profile)
            .unwrap();
        assert_eq!(provider.id(), ProviderId::Mock);
    }
}
