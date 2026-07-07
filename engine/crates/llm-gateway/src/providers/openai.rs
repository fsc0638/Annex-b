//! OpenAI provider: Chat Completions API direct connect (spec 6, ADR-001).
//! Disabled at construction time when `OPENAI_API_KEY` is absent/empty.

use async_trait::async_trait;
use serde_json::json;

use crate::provider::{ChatProvider, ChatRequest, ChatResponse, ProviderError, ProviderId};

const API_URL: &str = "https://api.openai.com/v1/chat/completions";

pub struct OpenAiProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        OpenAiProvider {
            api_key,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ChatProvider for OpenAiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Openai
    }

    fn is_enabled(&self) -> bool {
        self.api_key.is_some()
    }

    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::Disabled("openai".to_string()))?;

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
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
        });

        let resp = self
            .client
            .post(API_URL)
            .bearer_auth(api_key)
            .json(&body)
            .timeout(std::time::Duration::from_secs(60))
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
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| ProviderError::Parse("missing choices[0].message.content".to_string()))?
            .to_string();

        let input_tokens = parsed
            .get("usage")
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        let output_tokens = parsed
            .get("usage")
            .and_then(|u| u.get("completion_tokens"))
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
        let p = OpenAiProvider::new(None);
        assert!(!p.is_enabled());
    }

    #[test]
    fn enabled_when_key_present() {
        let p = OpenAiProvider::new(Some("sk-test".to_string()));
        assert!(p.is_enabled());
    }
}
