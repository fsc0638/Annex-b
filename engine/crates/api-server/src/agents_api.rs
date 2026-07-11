//! ADR-002 D5 `PATCH /api/v1/agents/:id` — per-agent customization
//! (name / seed_traits / core_identity / reply_style / llm_profile).
//! Does NOT reset the world or touch position — only updates the agent and
//! broadcasts a full `world_snapshot` (see D2's shared broadcast pattern
//! in `world_api.rs`).

use axum::extract::rejection::{JsonRejection, PathRejection};
use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;
use sim_core::world::AgentPatch;
use uuid::Uuid;

use crate::db_persist;
use crate::error::ApiError;
use crate::state::AppState;
use crate::world_api::persist_fixture;

pub async fn patch_agent(
    State(state): State<AppState>,
    // Taken as a `Result` so an unparseable `:id` (not a UUID) becomes this
    // crate's JSON error envelope instead of Axum's default plaintext 400
    // that the `Path<Uuid>` extractor would emit before the handler runs.
    id: Result<Path<Uuid>, PathRejection>,
    body: Result<Json<AgentPatch>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Path(id) =
        id.map_err(|e| ApiError::bad_request(format!("invalid agent id in path: {e}")))?;
    let sim = state.sim.clone().ok_or_else(|| {
        ApiError::service_unavailable("world not loaded (check WORLD_SOURCE / DATABASE_URL)")
    })?;
    let Json(patch) =
        body.map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))?;

    if let Some(profile) = &patch.llm_profile {
        validate_llm_profile(profile)?;
    }

    {
        let world = sim.world.lock().await;
        if world.agent_by_id(id).is_none() {
            return Err(ApiError::not_found(format!("agent {id} not found")));
        }
    }

    let snapshot = {
        let mut world = sim.world.lock().await;
        world
            .patch_agent(id, patch)
            .map_err(ApiError::unprocessable)?;
        let snap = world.snapshot_json();
        let _ = sim.events.send(snap.to_string());
        snap
    };

    if let Some(pool) = &state.db {
        let world = sim.world.lock().await;
        if let Some(sim_agent) = world.agent_by_id(id) {
            if let Err(e) = db_persist::save_agent(pool, &sim_agent.agent).await {
                tracing::warn!(error = %e, "failed to persist agents row");
            }
        }
    } else {
        persist_fixture(&sim).await;
    }

    Ok(Json(snapshot))
}

/// Validates `llm_profile` per ADR-002 D5, delegating to the shared rule in
/// `sim_core::llm_profile` (the single source of truth also used by the
/// fixture-mode persist load path) and mapping its message into this crate's
/// 422 envelope. Malformed input here is a loud 422, not a silent fallback
/// (unlike `llm_gateway::tier::resolve_tier_target`, whose hot-path job is to
/// fall back to the tier default).
fn validate_llm_profile(v: &Value) -> Result<(), ApiError> {
    sim_core::llm_profile::validate_llm_profile(v).map_err(ApiError::unprocessable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_llm_profile_accepts_valid_overrides() {
        assert!(validate_llm_profile(&json!({})).is_ok());
        assert!(validate_llm_profile(&json!({"L1": "openai:gpt-4o-mini"})).is_ok());
        assert!(validate_llm_profile(&json!({
            "L2": "anthropic:claude-haiku-4-5",
            "L3": "gemini:gemini-2.5-pro"
        }))
        .is_ok());
    }

    #[test]
    fn validate_llm_profile_rejects_l0() {
        let err = validate_llm_profile(&json!({"L0": "ollama:mxbai-embed-large"})).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains("L0"));
    }

    #[test]
    fn validate_llm_profile_rejects_unknown_tier_key() {
        let err = validate_llm_profile(&json!({"L4": "openai:gpt-4o"})).unwrap_err();
        assert!(err.message.contains("L4"));
    }

    #[test]
    fn validate_llm_profile_rejects_missing_colon() {
        let err = validate_llm_profile(&json!({"L1": "gpt-4o-mini"})).unwrap_err();
        assert!(err.message.contains("provider:model"));
    }

    #[test]
    fn validate_llm_profile_rejects_unknown_provider() {
        let err = validate_llm_profile(&json!({"L1": "notaprovider:some-model"})).unwrap_err();
        assert!(err.message.contains("unknown provider"));
    }

    #[test]
    fn validate_llm_profile_rejects_empty_model() {
        let err = validate_llm_profile(&json!({"L1": "openai:"})).unwrap_err();
        assert!(err.message.contains("model must not be empty"));
    }

    #[test]
    fn validate_llm_profile_rejects_non_object() {
        assert!(validate_llm_profile(&json!("not-an-object")).is_err());
        assert!(validate_llm_profile(&json!(["L1", "openai:gpt-4o"])).is_err());
    }
}
