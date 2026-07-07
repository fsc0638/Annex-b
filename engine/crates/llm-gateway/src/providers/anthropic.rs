//! Anthropic provider: Messages API direct connect (spec 6, ADR-001).
//! Disabled at construction time when `ANTHROPIC_API_KEY` is absent/empty
//! (spec: "金鑰 env 缺→該 provider disabled（healthz 註記）").

use async_trait::async_trait;
use serde_json::json;

use crate::provider::{ChatProvider, ChatRequest, ChatResponse, ProviderError, ProviderId};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(api_key: Option<String>) -> Self {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        AnthropicProvider {
            api_key,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ChatProvider for AnthropicProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Anthropic
    }

    fn is_enabled(&self) -> bool {
        self.api_key.is_some()
    }

    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::Disabled("anthropic".to_string()))?;

        // Anthropic Messages API separates system prompt from the turn list.
        let mut system_parts = Vec::new();
        let mut turns = Vec::new();
        for m in &req.messages {
            match m.role {
                crate::provider::ChatRole::System => system_parts.push(m.content.clone()),
                crate::provider::ChatRole::User => turns.push(json!({
                    "role": "user",
                    "content": m.content,
                })),
                crate::provider::ChatRole::Assistant => turns.push(json!({
                    "role": "assistant",
                    "content": m.content,
                })),
            }
        }

        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": turns,
        });
        if !system_parts.is_empty() {
            body["system"] = json!(system_parts.join("\n\n"));
        }

        let resp = self
            .client
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(90))
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
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|block| block.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| ProviderError::Parse("missing content[0].text".to_string()))?
            .to_string();

        let input_tokens = parsed
            .get("usage")
            .and_then(|u| u.get("input_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        let output_tokens = parsed
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        Ok(ChatResponse {
            content,
            input_tokens,
            output_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_when_no_key() {
        let p = AnthropicProvider::new(None);
        assert!(!p.is_enabled());
    }

    #[test]
    fn disabled_when_empty_key() {
        let p = AnthropicProvider::new(Some("   ".to_string()));
        assert!(!p.is_enabled());
    }

    #[test]
    fn enabled_when_key_present() {
        let p = AnthropicProvider::new(Some("sk-ant-test".to_string()));
        assert!(p.is_enabled());
    }
}
