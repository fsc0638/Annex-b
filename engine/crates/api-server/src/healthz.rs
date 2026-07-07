//! `GET /api/v1/healthz` (spec Phase 0 acceptance: "回報 DB 與 Ollama 皆
//! ok"; spec 6: "healthz 回報 db／ollama 可達性與三家雲端 enabled/disabled").

use axum::{extract::State, Json};
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct HealthzResponse {
    pub status: String,
    pub db: ComponentHealth,
    pub ollama: ComponentHealth,
    /// The 3 cloud providers only (anthropic/openai/gemini) — `ollama`'s
    /// reachability lives in the `ollama` field above instead of being
    /// duplicated here under a differently-scoped `enabled` meaning; see
    /// `llm_gateway::Gateway::provider_statuses`'s doc comment for why
    /// `ollama` and `mock` are excluded from this array.
    pub providers: Vec<llm_gateway::ProviderStatus>,
}

#[derive(Debug, Serialize)]
pub struct ComponentHealth {
    pub reachable: bool,
    pub detail: String,
}

pub async fn healthz(State(state): State<AppState>) -> Json<HealthzResponse> {
    let db = check_db(&state).await;
    let ollama = check_ollama(&state).await;
    let providers = state.gateway.provider_statuses();

    // Overall status is "ok" as long as the process can serve requests.
    // DB/Ollama/provider reachability are reported as sub-fields rather
    // than failing the whole endpoint, so operators can see partial
    // degradation instead of getting no signal at all.
    let response = HealthzResponse {
        status: "ok".to_string(),
        db,
        ollama,
        providers,
    };
    Json(response)
}

async fn check_db(state: &AppState) -> ComponentHealth {
    match &state.db {
        None => ComponentHealth {
            reachable: false,
            detail: "DATABASE_URL not configured or connection failed at startup".to_string(),
        },
        Some(pool) => match sqlx::query("select 1").execute(pool).await {
            Ok(_) => ComponentHealth {
                reachable: true,
                detail: "ok".to_string(),
            },
            Err(e) => ComponentHealth {
                reachable: false,
                detail: format!("query failed: {e}"),
            },
        },
    }
}

async fn check_ollama(state: &AppState) -> ComponentHealth {
    if state.gateway.ollama.ping().await {
        ComponentHealth {
            reachable: true,
            detail: "ok".to_string(),
        }
    } else {
        ComponentHealth {
            reachable: false,
            detail: "OLLAMA_BASE_URL unreachable".to_string(),
        }
    }
}
