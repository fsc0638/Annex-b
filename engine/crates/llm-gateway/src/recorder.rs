//! Metering: records every LLM call to `llm_calls` (spec 4, table
//! `llm_calls`). The recorder is a trait so tests and DB-less contexts can
//! inject a no-op implementation instead of a real Postgres writer — the
//! DB-backed implementation lives in api-server (Phase 1+, once sqlx pool
//! wiring exists end-to-end), keeping llm-gateway itself DB-agnostic.

use async_trait::async_trait;
use uuid::Uuid;

/// One row's worth of data for the `llm_calls` table.
#[derive(Debug, Clone)]
pub struct LlmCallRecord {
    pub world_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
    pub tier: String,
    pub provider: String,
    pub model: String,
    pub purpose: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cost_usd: f64,
    pub latency_ms: u32,
    pub ok: bool,
}

#[async_trait]
pub trait LlmCallRecorder: Send + Sync {
    async fn record(&self, call: LlmCallRecord);
}

/// No-op recorder: swallows every record. Used in tests and any context
/// without a DB connection available (per user instruction: "llm_calls 計量
/// （無 DB 時可注入 no-op recorder 供測試）").
pub struct NoopRecorder;

#[async_trait]
impl LlmCallRecorder for NoopRecorder {
    async fn record(&self, _call: LlmCallRecord) {
        // Intentionally does nothing.
    }
}

/// In-memory recorder: useful for tests that want to assert on what was
/// recorded without a DB.
#[derive(Default)]
pub struct InMemoryRecorder {
    calls: tokio::sync::Mutex<Vec<LlmCallRecord>>,
}

impl InMemoryRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn calls(&self) -> Vec<LlmCallRecord> {
        self.calls.lock().await.clone()
    }
}

#[async_trait]
impl LlmCallRecorder for InMemoryRecorder {
    async fn record(&self, call: LlmCallRecord) {
        self.calls.lock().await.push(call);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn noop_recorder_accepts_calls_without_panicking() {
        let recorder = NoopRecorder;
        recorder
            .record(LlmCallRecord {
                world_id: None,
                agent_id: None,
                tier: "L1".to_string(),
                provider: "mock".to_string(),
                model: "test".to_string(),
                purpose: "test".to_string(),
                input_tokens: Some(10),
                output_tokens: Some(5),
                cost_usd: 0.0,
                latency_ms: 1,
                ok: true,
            })
            .await;
    }

    #[tokio::test]
    async fn in_memory_recorder_stores_calls() {
        let recorder = InMemoryRecorder::new();
        recorder
            .record(LlmCallRecord {
                world_id: None,
                agent_id: None,
                tier: "L1".to_string(),
                provider: "mock".to_string(),
                model: "test".to_string(),
                purpose: "unit-test".to_string(),
                input_tokens: Some(10),
                output_tokens: Some(5),
                cost_usd: 0.001,
                latency_ms: 42,
                ok: true,
            })
            .await;
        let calls = recorder.calls().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].purpose, "unit-test");
    }
}
