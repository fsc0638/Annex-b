//! Gemini provider: `generateContent` API direct connect (spec 6, ADR-001).
//! Disabled at construction time when `GEMINI_API_KEY` is absent/empty.

use async_trait::async_trait;
use serde_json::json;

use crate::provider::{ChatProvider, ChatRequest, ChatResponse, ProviderError, ProviderId};

pub struct GeminiProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl GeminiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        GeminiProvider {
            api_key,
            client: reqwest::Client::new(),
        }
    }

    fn endpoint(model: &str) -> String {
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")
    }
}

#[async_trait]
impl ChatProvider for GeminiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Gemini
    }

    fn is_enabled(&self) -> bool {
        self.api_key.is_some()
    }

    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::Disabled("gemini".to_string()))?;

        // Gemini has a distinct systemInstruction field; user/assistant map
        // to contents with roles "user"/"model".
        let mut system_parts = Vec::new();
        let mut contents = Vec::new();
        for m in &req.messages {
            match m.role {
                crate::provider::ChatRole::System => system_parts.push(m.content.clone()),
                crate::provider::ChatRole::User => contents.push(json!({
                    "role": "user",
                    "parts": [{"text": m.content}],
                })),
                crate::provider::ChatRole::Assistant => contents.push(json!({
                    "role": "model",
                    "parts": [{"text": m.content}],
                })),
            }
        }

        let mut body = json!({
            "contents": contents,
            "generationConfig": {
                "temperature": req.temperature,
                "maxOutputTokens": req.max_tokens,
            }
        });
        if !system_parts.is_empty() {
            body["systemInstruction"] = json!({
                "parts": [{"text": system_parts.join("\n\n")}]
            });
        }

        let url = Self::endpoint(&req.model);
        let resp = self
            .client
            .post(&url)
            .header("x-goog-api-key", api_key)
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
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|cand| cand.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
            .and_then(|arr| arr.first())
            .and_then(|part| part.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| {
                ProviderError::Parse("missing candidates[0].content.parts[0].text".to_string())
            })?
            .to_string();

        let input_tokens = parsed
            .get("usageMetadata")
            .and_then(|u| u.get("promptTokenCount"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        let output_tokens = parsed
            .get("usageMetadata")
            .and_then(|u| u.get("candidatesTokenCount"))
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
        let p = GeminiProvider::new(None);
        assert!(!p.is_enabled());
    }

    #[test]
    fn enabled_when_key_present() {
        let p = GeminiProvider::new(Some("test-key".to_string()));
        assert!(p.is_enabled());
    }

    #[test]
    fn endpoint_includes_model() {
        let url = GeminiProvider::endpoint("gemini-2.5-pro");
        assert!(url.contains("gemini-2.5-pro"));
        assert!(url.contains("generateContent"));
    }
}
