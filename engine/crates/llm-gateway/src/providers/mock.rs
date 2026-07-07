//! Mock provider: deterministic responses for `LLM_MODE=mock` (spec 6.1,
//! success criterion S6 — "同 seed + mock LLM 下模擬 100% 可重現").
//!
//! Determinism strategy: the response is a pure function of the request
//! content (last user message + model name), using a stable hash. No
//! wall-clock time, no randomness. Given the same input messages, the same
//! output is produced every call, in every process, forever.

use async_trait::async_trait;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::provider::{ChatProvider, ChatRequest, ChatResponse, ProviderError, ProviderId};

pub struct MockProvider;

impl MockProvider {
    pub fn new() -> Self {
        MockProvider
    }
}

impl Default for MockProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Pure function: deterministic content hash used to derive mock output.
/// Exposed for unit testing independent of the async trait machinery.
pub fn deterministic_seed(model: &str, last_user_content: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    model.hash(&mut hasher);
    last_user_content.hash(&mut hasher);
    hasher.finish()
}

/// Pure function: builds the mock reply text. If the prompt looks like it
/// demands JSON output (contains "只輸出 JSON" or starts with a JSON
/// instruction marker), returns a minimal valid JSON stub so downstream
/// JSON-guard parsing exercises the same path as real providers.
pub fn mock_reply(model: &str, last_user_content: &str) -> String {
    let seed = deterministic_seed(model, last_user_content);
    if last_user_content.contains("只輸出 JSON") || last_user_content.contains("JSON 陣列") {
        format!("{{\"mock\": true, \"seed\": {seed}}}")
    } else {
        format!("[mock:{seed:x}] deterministic reply for testing")
    }
}

#[async_trait]
impl ChatProvider for MockProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    fn is_enabled(&self) -> bool {
        true
    }

    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let last_user = req
            .messages
            .iter()
            .rev()
            .find(|m| matches!(m.role, crate::provider::ChatRole::User))
            .map(|m| m.content.as_str())
            .unwrap_or("");
        let content = mock_reply(&req.model, last_user);
        let input_tokens = req
            .messages
            .iter()
            .map(|m| m.content.len() as u32 / 4)
            .sum();
        let output_tokens = content.len() as u32 / 4;
        Ok(ChatResponse {
            content,
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ChatMessage, ChatRole};

    #[test]
    fn deterministic_seed_is_stable_across_calls() {
        let a = deterministic_seed("qwen2.5:7b-instruct", "hello");
        let b = deterministic_seed("qwen2.5:7b-instruct", "hello");
        assert_eq!(a, b);
    }

    #[test]
    fn deterministic_seed_varies_with_input() {
        let a = deterministic_seed("qwen2.5:7b-instruct", "hello");
        let b = deterministic_seed("qwen2.5:7b-instruct", "goodbye");
        assert_ne!(a, b);
    }

    #[test]
    fn mock_reply_emits_json_stub_when_json_demanded() {
        let out = mock_reply("m", "please answer. 只輸出 JSON.");
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    }

    #[tokio::test]
    async fn chat_is_reproducible_given_same_seed_input() {
        let provider = MockProvider::new();
        let req = || ChatRequest {
            model: "test-model".to_string(),
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: "same input".to_string(),
            }],
            max_tokens: 100,
            temperature: 0.0,
        };
        let r1 = provider.chat(req()).await.unwrap();
        let r2 = provider.chat(req()).await.unwrap();
        assert_eq!(r1.content, r2.content);
    }
}
