//! ADR-002 D5 `PATCH /api/v1/agents/:id` — per-agent customization
//! (name / seed_traits / core_identity / reply_style / llm_profile).
//! Does NOT reset the world or touch position — only updates the agent and
//! broadcasts a full `world_snapshot` (see D2's shared broadcast pattern
//! in `world_api.rs`).

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::Json;
use llm_gateway::provider::ProviderId;
use serde_json::Value;
use sim_core::world::AgentPatch;
use uuid::Uuid;

use crate::db_persist;
use crate::error::ApiError;
use crate::state::AppState;
use crate::world_api::persist_fixture;

pub async fn patch_agent(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    body: Result<Json<AgentPatch>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
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

/// Validates `llm_profile` per ADR-002 D5: must be a JSON object; every key
/// must be one of L1/L2/L3 (L0 is never overridable — spec 6.1 v2.1); every
/// value must be a `"provider:model"` string with a known provider and a
/// non-empty model. Unlike `llm_gateway::tier::resolve_tier_target` (which
/// silently falls back to the tier default on malformed input, appropriate
/// for a hot runtime path), this is a validation gate for user-submitted
/// data — malformed input here is a loud 422, not a silent fallback.
fn validate_llm_profile(v: &Value) -> Result<(), ApiError> {
    let obj = v
        .as_object()
        .ok_or_else(|| ApiError::unprocessable("llm_profile must be a JSON object"))?;
    for (key, val) in obj {
        match key.as_str() {
            "L1" | "L2" | "L3" => {}
            "L0" => {
                return Err(ApiError::unprocessable(
                    "llm_profile must not override L0 (spec 6.1: L0 is pinned, never overridable)",
                ))
            }
            other => {
                return Err(ApiError::unprocessable(format!(
                    "llm_profile: unknown tier key '{other}' (allowed: L1, L2, L3)"
                )))
            }
        }
        let s = val.as_str().ok_or_else(|| {
            ApiError::unprocessable(format!("llm_profile.{key} must be a string"))
        })?;
        let (provider, model) = s.split_once(':').ok_or_else(|| {
            ApiError::unprocessable(format!(
                "llm_profile.{key} must be formatted as \"provider:model\", got '{s}'"
            ))
        })?;
        if ProviderId::parse(provider).is_none() {
            return Err(ApiError::unprocessable(format!(
                "llm_profile.{key}: unknown provider '{provider}'"
            )));
        }
        if model.is_empty() {
            return Err(ApiError::unprocessable(format!(
                "llm_profile.{key}: model must not be empty"
            )));
        }
    }
    Ok(())
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
