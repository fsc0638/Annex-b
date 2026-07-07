//! Provider abstraction: the minimal chat interface every LLM backend
//! implements (spec section 6). Ollama additionally exposes embeddings
//! since L0 (embedding/importance) is pinned to local inference (spec 6.1
//! v2.1 note: "L0 不可覆寫——統一走本地").

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Canonical provider identifiers used in `agents.llm_profile` override
/// strings (`"provider:model"`) and in `llm_calls.provider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Anthropic,
    Openai,
    Gemini,
    Ollama,
    Mock,
}

impl ProviderId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::Anthropic => "anthropic",
            ProviderId::Openai => "openai",
            ProviderId::Gemini => "gemini",
            ProviderId::Ollama => "ollama",
            ProviderId::Mock => "mock",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "anthropic" => Some(ProviderId::Anthropic),
            "openai" => Some(ProviderId::Openai),
            "gemini" => Some(ProviderId::Gemini),
            "ollama" => Some(ProviderId::Ollama),
            "mock" => Some(ProviderId::Mock),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub temperature: f32,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct EmbeddingRequest {
    pub model: String,
    pub input: String,
}

#[derive(Debug, Clone)]
pub struct EmbeddingResponse {
    pub embedding: Vec<f32>,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider disabled: {0}")]
    Disabled(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("upstream error ({status}): {body}")]
    Upstream { status: u16, body: String },
    #[error("response parse error: {0}")]
    Parse(String),
    #[error("timeout")]
    Timeout,
}

/// Minimal chat interface every provider implements.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    fn id(&self) -> ProviderId;

    /// Whether this provider is usable (e.g. API key present in env, or
    /// local endpoint reachable). Gateways should consult this before
    /// routing and reflect it in `GET /healthz`.
    fn is_enabled(&self) -> bool;

    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, ProviderError>;
}

/// Embeddings are only offered by Ollama in this system (L0 is pinned to
/// local inference — see module docs).
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    async fn embed(&self, req: EmbeddingRequest) -> Result<EmbeddingResponse, ProviderError>;
}
