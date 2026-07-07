//! Ollama provider: local inference via `OLLAMA_BASE_URL`. Chat (L0/L1
//! default tier) and embeddings (L0, pinned per spec 6.1 v2.1 note).
//! Ollama has no API key gate: it is "enabled" whenever a base URL is
//! configured. Reachability is a runtime health-check concern (healthz),
//! not a construction-time gate.

use async_trait::async_trait;
use serde_json::json;

use crate::provider::{
    ChatProvider, ChatRequest, ChatResponse, EmbeddingProvider, EmbeddingRequest,
    EmbeddingResponse, ProviderError, ProviderId,
};

pub struct OllamaProvider {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(base_url: impl Into<String>) -> Self {
        OllamaProvider {
            base_url: base_url.into(),
            client: reqwest::Client::new(),
        }
    }

    /// Best-effort reachability check for healthz. Does not affect
    /// `is_enabled()` (construction-time), used separately by callers
    /// that want a live probe.
    pub async fn ping(&self) -> bool {
        let url = format!("{}/api/tags", self.base_url.trim_end_matches('/'));
        matches!(
            self.client
                .get(&url)
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await,
            Ok(resp) if resp.status().is_success()
        )
    }
}

#[async_trait]
impl ChatProvider for OllamaProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Ollama
    }

    fn is_enabled(&self) -> bool {
        !self.base_url.is_empty()
    }

    async fn chat(
        &self,
        req: ChatRequest,
        timeout: std::time::Duration,
    ) -> Result<ChatResponse, ProviderError> {
        if !self.is_enabled() {
            return Err(ProviderError::Disabled("ollama".to_string()));
        }
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let messages: Vec<_> = req
            .messages
            .iter()
            .map(|m| {
                json!({
                    "role": match m.role {
                        crate::provider::ChatRole::System => "system",
                        crate::provider::ChatRole::User => "user",
                        crate::provider::ChatRole::Assistant => "assistant",
                    },
                    "content": m.content,
                })
            })
            .collect();
        let body = json!({
            "model": req.model,
            "messages": messages,
            "stream": false,
            "options": {
                "temperature": req.temperature,
                "num_predict": req.max_tokens,
            }
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .timeout(timeout)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Upstream {
                status: status.as_u16(),
                body: text,
            });
        }
        let parsed: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))?;
        let content = parsed
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| ProviderError::Parse("missing message.content".to_string()))?
            .to_string();
        let input_tokens = parsed
            .get("prompt_eval_count")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        let output_tokens = parsed
            .get("eval_count")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        Ok(ChatResponse {
            content,
            input_tokens,
            output_tokens,
        })
    }
}

#[async_trait]
impl EmbeddingProvider for OllamaProvider {
    async fn embed(
        &self,
        req: EmbeddingRequest,
        timeout: std::time::Duration,
    ) -> Result<EmbeddingResponse, ProviderError> {
        if !self.is_enabled() {
            return Err(ProviderError::Disabled("ollama".to_string()));
        }
        let url = format!("{}/api/embeddings", self.base_url.trim_end_matches('/'));
        let body = json!({
            "model": req.model,
            "prompt": req.input,
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .timeout(timeout)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Upstream {
                status: status.as_u16(),
                body: text,
            });
        }
        let parsed: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))?;
        let embedding = parsed
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ProviderError::Parse("missing embedding array".to_string()))?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();
        Ok(EmbeddingResponse { embedding })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_when_base_url_present() {
        let p = OllamaProvider::new("http://localhost:11434");
        assert!(p.is_enabled());
    }

    #[test]
    fn disabled_when_base_url_empty() {
        let p = OllamaProvider::new("");
        assert!(!p.is_enabled());
    }
}
