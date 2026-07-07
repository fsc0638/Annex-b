//! llm-gateway: routing, queueing, metering, mock (spec section 6).
//!
//! Phase 0 scope (T0.4): provider trait + 5 implementations
//! (anthropic/openai/gemini/ollama/mock), tier routing table with
//! `agents.llm_profile` override, `LLM_MODE=mock` switch, tier-level
//! timeout/retry (spec 6.1's table) applied at the gateway call site,
//! `llm_calls` metering via an injectable recorder, `pricing.toml` loading
//! + pure cost function, and `DAILY_BUDGET_USD` threshold functions.
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

use provider::{ChatProvider, ChatRequest, ChatResponse, ProviderError, ProviderId};
use providers::{
    anthropic::AnthropicProvider, gemini::GeminiProvider, mock::MockProvider,
    ollama::OllamaProvider, openai::OpenAiProvider,
};
use tier::{TierDefaults, TierTarget};

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
    /// override (spec 6.1 v2.1). Returns `(provider, model)` only — see
    /// `resolve_target_for_tier` for the full `TierTarget` including
    /// timeout/retry policy.
    pub fn resolve_provider_for_tier(
        &self,
        tier: tier::Tier,
        llm_profile: &serde_json::Value,
    ) -> Option<(Arc<dyn ChatProvider>, String)> {
        self.resolve_target_for_tier(tier, llm_profile)
            .and_then(|target| self.provider(target.provider).map(|p| (p, target.model)))
    }

    /// Resolve the full tier target (provider, model, timeout, max_retries)
    /// for a tier + agent profile, honoring `LLM_MODE=mock` (always wins)
    /// and the llm_profile override. Mock mode still carries the *real*
    /// tier's timeout/max_retries (derived directly from `Tier`, spec
    /// 6.1's table) rather than defaulting them away, so retry-loop
    /// behavior is exercised identically in mock and real mode — only the
    /// provider/model selection differs.
    pub fn resolve_target_for_tier(
        &self,
        tier: tier::Tier,
        llm_profile: &serde_json::Value,
    ) -> Option<TierTarget> {
        if self.mode == LlmMode::Mock {
            let model = self
                .tier_defaults
                .get(tier)
                .map(|t| t.model.clone())
                .unwrap_or_else(|| "mock-model".to_string());
            return Some(TierTarget {
                provider: ProviderId::Mock,
                model,
                timeout: tier.timeout(),
                max_retries: tier.max_retries(),
            });
        }
        tier::resolve_tier_target(tier, &self.tier_defaults, llm_profile)
    }

    /// Resolve a tier target and execute the chat call through the retry
    /// loop (spec 6.1: tier-level timeout + retry count), using whichever
    /// provider the tier resolves to. This is the entry point Phase 1+
    /// callers (agent-core) should use instead of calling a provider's
    /// `chat()` directly, so tier policy is always applied consistently.
    pub async fn chat_for_tier(
        &self,
        tier: tier::Tier,
        llm_profile: &serde_json::Value,
        req: ChatRequest,
    ) -> Result<ChatResponse, ProviderError> {
        let target = self
            .resolve_target_for_tier(tier, llm_profile)
            .ok_or_else(|| ProviderError::Disabled("no target resolved for tier".to_string()))?;
        let provider = self
            .provider(target.provider)
            .ok_or_else(|| ProviderError::Disabled(target.provider.as_str().to_string()))?;
        chat_with_retry(provider.as_ref(), req, target.timeout, target.max_retries).await
    }

    /// Status of the three cloud providers for healthz reporting (spec 6.1:
    /// "未設金鑰的供應商停用並於 healthz 註記" — language specific to the
    /// three cloud providers' API-key presence).
    ///
    /// `ollama` is deliberately excluded here: it has no API-key concept
    /// (`enabled` there would mean "base URL configured", a different
    /// semantic from the cloud providers' key-presence check under the
    /// same field name), and it already gets its own top-level
    /// `HealthzResponse.ollama: ComponentHealth` field in api-server with a
    /// live reachability probe — including it here too would be a
    /// duplicate, differently-shaped entry in the same array.
    ///
    /// `mock` is also excluded: it is always enabled and never selected by
    /// tier routing in `LlmMode::Real` (only `LLM_MODE=mock` routes to it,
    /// which is a global mode switch, not a per-provider health concern),
    /// so surfacing it in an operator-facing healthz endpoint would be
    /// noise rather than signal.
    pub fn provider_statuses(&self) -> Vec<ProviderStatus> {
        let mut ids = vec![
            ProviderId::Anthropic,
            ProviderId::Openai,
            ProviderId::Gemini,
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

/// Retry loop for a chat call, applying tier-level timeout + retry-count
/// policy (spec 6.1's table) at the gateway call site rather than inside
/// individual providers — this is why `ChatProvider::chat` takes a
/// `timeout` parameter instead of hardcoding one. `max_retries` is a
/// *retry* count per the spec table (e.g. L2's `2` means up to 3 total
/// attempts: the initial attempt plus 2 retries); `0` means exactly one
/// attempt, no retry.
///
/// Every attempt gets the same `timeout` — the spec table assigns one
/// timeout value per tier, not a per-attempt backoff schedule, so there is
/// no growing/shrinking timeout across retries. Returns the first success,
/// or the *last* error if every attempt fails (earlier attempts' errors
/// are not accumulated — this matches the gateway's general "fail toward a
/// single clear signal" posture used elsewhere, e.g. `pricing`/`budget`).
///
/// `req` must be `Clone` because a failed attempt consumes the request by
/// value into the provider call; `ChatRequest` already derives `Clone`.
pub async fn chat_with_retry(
    provider: &dyn ChatProvider,
    req: ChatRequest,
    timeout: std::time::Duration,
    max_retries: u32,
) -> Result<ChatResponse, ProviderError> {
    let total_attempts = max_retries + 1;
    let mut last_err = None;
    for attempt in 0..total_attempts {
        match provider.chat(req.clone(), timeout).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                tracing::warn!(
                    provider = provider.id().as_str(),
                    attempt = attempt + 1,
                    total_attempts,
                    error = %e,
                    "chat attempt failed"
                );
                last_err = Some(e);
            }
        }
    }
    // Unwrap is safe: the loop runs at least once (total_attempts >= 1
    // since max_retries: u32 >= 0), so last_err is always Some by here.
    Err(last_err.expect("retry loop always runs at least once"))
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
        // Mutates ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY, which
        // `Gateway::from_env()` reads — per this module's own ENV_MUTEX
        // doc comment above, any test mutating env vars read by
        // `from_env()` must hold the lock for its full span.
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("ANTHROPIC_API_KEY");
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("GEMINI_API_KEY");
        let gateway = Gateway::from_env();
        let statuses = gateway.provider_statuses();
        let anthropic = statuses.iter().find(|s| s.provider == "anthropic").unwrap();
        assert!(!anthropic.enabled);
    }

    #[test]
    fn gateway_provider_statuses_includes_exactly_three_cloud_providers() {
        // Major #4 fix: `providers` strictly matches the three-cloud-
        // provider spec language. `ollama` has its own top-level
        // ComponentHealth field (api-server's HealthzResponse) instead of
        // living here, and `mock` is excluded as operator noise — see
        // `provider_statuses`'s doc comment for the full rationale.
        let gateway = Gateway::from_env();
        let statuses = gateway.provider_statuses();
        let names: Vec<_> = statuses.iter().map(|s| s.provider.as_str()).collect();
        assert!(names.contains(&"anthropic"));
        assert!(names.contains(&"openai"));
        assert!(names.contains(&"gemini"));
        assert!(!names.contains(&"ollama"));
        assert!(!names.contains(&"mock"));
        assert_eq!(statuses.len(), 3);
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

    #[tokio::test]
    async fn resolve_target_for_tier_carries_spec_timeout_and_retries() {
        let mut gateway = Gateway::from_env();
        gateway.mode = LlmMode::Real;
        let profile = serde_json::json!({});
        let l2 = gateway
            .resolve_target_for_tier(tier::Tier::L2, &profile)
            .unwrap();
        assert_eq!(l2.timeout, std::time::Duration::from_secs(60));
        assert_eq!(l2.max_retries, 2);

        let l3 = gateway
            .resolve_target_for_tier(tier::Tier::L3, &profile)
            .unwrap();
        assert_eq!(l3.timeout, std::time::Duration::from_secs(90));
        assert_eq!(l3.max_retries, 1);
    }

    #[tokio::test]
    async fn resolve_target_for_tier_in_mock_mode_still_carries_real_tier_policy() {
        // Mock mode swaps the *provider* to Mock but must not silently
        // drop the tier's timeout/retry policy — retry-loop behavior
        // should be identical in mock and real mode.
        let mut gateway = Gateway::from_env();
        gateway.mode = LlmMode::Mock;
        let profile = serde_json::json!({});
        let target = gateway
            .resolve_target_for_tier(tier::Tier::L2, &profile)
            .unwrap();
        assert_eq!(target.provider, ProviderId::Mock);
        assert_eq!(target.timeout, std::time::Duration::from_secs(60));
        assert_eq!(target.max_retries, 2);
    }

    /// Test double for the retry loop: a `ChatProvider` that fails its
    /// first `fail_count` calls with `ProviderError::Timeout`, then
    /// succeeds on every call after that. Call count is tracked via an
    /// `AtomicU32` (interior mutability, since `ChatProvider::chat` takes
    /// `&self`) so tests can assert exactly how many attempts were made.
    struct FlakyProvider {
        fail_count: u32,
        calls_made: std::sync::atomic::AtomicU32,
    }

    impl FlakyProvider {
        fn new(fail_count: u32) -> Self {
            FlakyProvider {
                fail_count,
                calls_made: std::sync::atomic::AtomicU32::new(0),
            }
        }

        fn calls_made(&self) -> u32 {
            self.calls_made.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl ChatProvider for FlakyProvider {
        fn id(&self) -> ProviderId {
            ProviderId::Mock
        }

        fn is_enabled(&self) -> bool {
            true
        }

        async fn chat(
            &self,
            _req: ChatRequest,
            _timeout: std::time::Duration,
        ) -> Result<ChatResponse, ProviderError> {
            let attempt = self
                .calls_made
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if attempt < self.fail_count {
                return Err(ProviderError::Timeout);
            }
            Ok(ChatResponse {
                content: "ok".to_string(),
                input_tokens: Some(1),
                output_tokens: Some(1),
            })
        }
    }

    fn sample_chat_request() -> ChatRequest {
        ChatRequest {
            model: "test-model".to_string(),
            messages: vec![],
            max_tokens: 10,
            temperature: 0.0,
        }
    }

    #[tokio::test]
    async fn l2_retry_gives_up_after_exhausting_all_attempts() {
        // L2 = max_retries 2 -> 3 total attempts. Failing all 3 must
        // return an error, not panic or hang.
        let provider = FlakyProvider::new(3);
        let result = chat_with_retry(
            &provider,
            sample_chat_request(),
            std::time::Duration::from_secs(60),
            tier::Tier::L2.max_retries(),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(provider.calls_made(), 3);
    }

    #[tokio::test]
    async fn l2_retry_succeeds_after_two_failures_within_budget() {
        // L2 allows up to 3 total attempts; failing twice then succeeding
        // on the 3rd attempt must return Ok, using exactly 3 calls.
        let provider = FlakyProvider::new(2);
        let result = chat_with_retry(
            &provider,
            sample_chat_request(),
            std::time::Duration::from_secs(60),
            tier::Tier::L2.max_retries(),
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(provider.calls_made(), 3);
    }

    #[tokio::test]
    async fn first_attempt_success_makes_exactly_one_call() {
        let provider = FlakyProvider::new(0);
        let result = chat_with_retry(
            &provider,
            sample_chat_request(),
            std::time::Duration::from_secs(60),
            tier::Tier::L2.max_retries(),
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(provider.calls_made(), 1);
    }

    #[tokio::test]
    async fn l3_retry_allows_only_one_retry_two_total_attempts() {
        // L3 = max_retries 1 -> 2 total attempts. Failing twice exhausts
        // the budget and must return an error using exactly 2 calls.
        let provider = FlakyProvider::new(2);
        let result = chat_with_retry(
            &provider,
            sample_chat_request(),
            std::time::Duration::from_secs(90),
            tier::Tier::L3.max_retries(),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(provider.calls_made(), 2);
    }

    #[tokio::test]
    async fn zero_max_retries_makes_exactly_one_attempt_and_fails() {
        let provider = FlakyProvider::new(1);
        let result = chat_with_retry(
            &provider,
            sample_chat_request(),
            std::time::Duration::from_secs(15),
            0,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(provider.calls_made(), 1);
    }

    #[tokio::test]
    async fn chat_for_tier_routes_through_retry_loop_in_mock_mode() {
        // End-to-end: Gateway::chat_for_tier in mock mode should resolve
        // to the Mock provider (always succeeds) and return Ok using the
        // real tier's timeout/retry policy under the hood.
        let mut gateway = Gateway::from_env();
        gateway.mode = LlmMode::Mock;
        let profile = serde_json::json!({});
        let result = gateway
            .chat_for_tier(tier::Tier::L1, &profile, sample_chat_request())
            .await;
        assert!(result.is_ok());
    }
}
