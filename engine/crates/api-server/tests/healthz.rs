//! Integration test for `GET /api/v1/healthz` (spec Phase 0 acceptance).
//! Runs without a real DB or Ollama — asserts the endpoint responds 200
//! and reports honest "unreachable" sub-statuses rather than crashing.

use std::sync::Arc;

use api_server::{router::build_router, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use llm_gateway::Gateway;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_returns_200_without_db_or_ollama() {
    // No DATABASE_URL/OLLAMA_BASE_URL configured for this test process;
    // the server must still boot and answer, reporting components as
    // unreachable rather than panicking or hanging.
    let state = AppState {
        db: None,
        gateway: Arc::new(Gateway::from_env()),
    };
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["status"], "ok");
    assert_eq!(json["db"]["reachable"], false);
    // providers array must list all 4 non-mock providers regardless of
    // whether keys are configured for this test run.
    let providers = json["providers"].as_array().unwrap();
    let names: Vec<&str> = providers
        .iter()
        .map(|p| p["provider"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"anthropic"));
    assert!(names.contains(&"openai"));
    assert!(names.contains(&"gemini"));
    assert!(names.contains(&"ollama"));
}
