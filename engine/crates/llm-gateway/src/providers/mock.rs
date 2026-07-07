//! Mock provider: deterministic responses for `LLM_MODE=mock` (spec 6.1,
//! success criterion S6 — "同 seed + mock LLM 下模擬 100% 可重現").
//!
//! Determinism strategy: the response is a pure function of the request
//! content (last user message + model name), using a stable hash. No
//! wall-clock time, no randomness. Given the same input messages, the same
//! output is produced every call, in every process, stably under the same
//! hashing algorithm (see `fnv1a_64` below — deliberately not
//! `std::collections::hash_map::DefaultHasher`, whose specific algorithm
//! Rust's std does not contractually guarantee stable across compiler
//! versions; `rust-toolchain.toml` at the repo root additionally pins the
//! toolchain itself as a belt-and-suspenders measure for S6's golden-replay
//! guarantee).

use async_trait::async_trait;

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

/// FNV-1a (64-bit): a small, non-cryptographic hash whose algorithm is
/// fully specified by this function body (not by any std/toolchain
/// implementation detail), so it is stable across Rust versions by
/// construction. Constants are FNV-1a's standard 64-bit offset basis and
/// prime. Not exposed outside this module — `deterministic_seed` below is
/// the intended public entry point.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Pure function: deterministic content hash used to derive mock output.
/// Exposed for unit testing independent of the async trait machinery.
pub fn deterministic_seed(model: &str, last_user_content: &str) -> u64 {
    // A single `\0`-separated buffer avoids the classic hash-concatenation
    // ambiguity (("ab","c") vs ("a","bc") must not collide).
    let mut buf = Vec::with_capacity(model.len() + last_user_content.len() + 1);
    buf.extend_from_slice(model.as_bytes());
    buf.push(0);
    buf.extend_from_slice(last_user_content.as_bytes());
    fnv1a_64(&buf)
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

    async fn chat(
        &self,
        req: ChatRequest,
        _timeout: std::time::Duration,
    ) -> Result<ChatResponse, ProviderError> {
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
    fn deterministic_seed_matches_known_fnv1a_golden_value() {
        // Locks the actual algorithm (FNV-1a, 64-bit, model + \0 +
        // content) against a golden value computed independently in
        // Python (standard FNV-1a offset basis 0xcbf29ce484222325, prime
        // 0x100000001b3, over b"m" + b"\x00" + b"hi"), so a future
        // accidental change to the hashing scheme (not just "does it
        // still vary") would be caught here.
        let seed = deterministic_seed("m", "hi");
        assert_eq!(seed, 0x2d96_34a3_6825_378b);
    }

    #[test]
    fn deterministic_seed_does_not_collide_across_the_separator() {
        // Classic hash-concatenation pitfall: without an unambiguous
        // separator, ("ab", "c") and ("a", "bc") could hash identically.
        let a = deterministic_seed("ab", "c");
        let b = deterministic_seed("a", "bc");
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
        let timeout = std::time::Duration::from_secs(5);
        let r1 = provider.chat(req(), timeout).await.unwrap();
        let r2 = provider.chat(req(), timeout).await.unwrap();
        assert_eq!(r1.content, r2.content);
    }
}
