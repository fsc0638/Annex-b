//! `PATCH /api/v1/agents/:id` integration tests (ADR-002 D5 acceptance:
//! success + at least one validation-failure case), driven with
//! `tower::ServiceExt::oneshot`. Uses the sim-core fixture world (9 seeded
//! agents) since PATCH doesn't touch the map/layout.

use std::sync::Arc;

use api_server::router::build_router;
use api_server::state::{AppState, SimHandle};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use llm_gateway::Gateway;
use sim_core::fixture::load_world_state_from_fixture_files;
use tower::ServiceExt;
use uuid::Uuid;

/// See tests/world_api.rs's `ENV_MUTEX` doc comment — same hazard, same
/// convention (`tokio::sync::Mutex` because the guard is held across
/// `.await` points), but a file-local static since integration test files
/// each compile to their own binary/process.
static ENV_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn test_state() -> (AppState, Arc<SimHandle>) {
    let world = load_world_state_from_fixture_files().expect("fixture world loads");
    let handle = SimHandle::new(world);
    let state = AppState {
        db: None,
        gateway: Arc::new(Gateway::from_env()),
        sim: Some(handle.clone()),
    };
    (state, handle)
}

async fn body_json(response: axum::response::Response<Body>) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn point_world_save_path_at_tmp() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("api-server-agents-api-test-{}", Uuid::new_v4()));
    let path = dir.join("world_save.json");
    std::env::set_var("WORLD_SAVE_PATH", &path);
    path
}

#[tokio::test]
async fn patch_agent_updates_fields_and_broadcasts_without_resetting_world() {
    let _guard = ENV_MUTEX.lock().await;
    let tmp_path = point_world_save_path_at_tmp();

    let (state, handle) = test_state();
    let mut rx = handle.events.subscribe();
    let agent_id = {
        let world = handle.world.lock().await;
        world.agents[0].agent.id
    };
    let clock_before = {
        let world = handle.world.lock().await;
        world.world.sim_clock_sec
    };
    let app = build_router(state);

    let body = serde_json::json!({
        "reply_style": "簡潔有力，語畢即止",
        "seed_traits": "新特質描述",
        "llm_profile": {"L2": "openai:gpt-4o-mini"}
    })
    .to_string();

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/agents/{agent_id}"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["type"], "world_snapshot");
    let patched = json["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == agent_id.to_string())
        .unwrap();
    assert_eq!(patched["reply_style"], "簡潔有力，語畢即止");
    assert_eq!(patched["seed_traits"], "新特質描述");
    assert_eq!(patched["llm_profile"]["L2"], "openai:gpt-4o-mini");
    // PATCH must not reset the world (ADR-002 D5: "不重置、不動位置").
    assert_eq!(json["world"]["sim_clock_sec"], clock_before);

    let broadcast = rx.try_recv().expect("a snapshot was broadcast");
    let v: serde_json::Value = serde_json::from_str(&broadcast).unwrap();
    assert_eq!(v["type"], "world_snapshot");

    assert!(
        tmp_path.exists(),
        "PATCH must persist the fixture save file"
    );
    std::fs::remove_dir_all(tmp_path.parent().unwrap()).ok();
}

#[tokio::test]
async fn patch_agent_rejects_l0_override_with_422() {
    let (state, handle) = test_state();
    let agent_id = {
        let world = handle.world.lock().await;
        world.agents[0].agent.id
    };
    let app = build_router(state);

    let body = serde_json::json!({ "llm_profile": {"L0": "ollama:mxbai-embed-large"} }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/agents/{agent_id}"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["error"]["code"], "validation_failed");
    assert!(json["error"]["message"].as_str().unwrap().contains("L0"));
}

#[tokio::test]
async fn patch_agent_rejects_duplicate_name_with_422() {
    let (state, handle) = test_state();
    let (id_a, name_b) = {
        let world = handle.world.lock().await;
        (world.agents[0].agent.id, world.agents[1].agent.name.clone())
    };
    let app = build_router(state);

    let body = serde_json::json!({ "name": name_b }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/agents/{id_a}"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert!(json["error"]["message"]
        .as_str()
        .unwrap()
        .contains("already used"));
}

#[tokio::test]
async fn patch_agent_returns_404_for_unknown_id() {
    let (state, _handle) = test_state();
    let app = build_router(state);

    let body = serde_json::json!({ "reply_style": "x" }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/agents/{}", Uuid::new_v4()))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let json = body_json(response).await;
    assert_eq!(json["error"]["code"], "not_found");
}
