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
        sim: None,
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
    // `providers` lists exactly the 3 cloud providers (spec 6.1 language
    // is specific to cloud providers' API-key presence); `ollama` has its
    // own top-level `ollama` field instead (asserted below) rather than a
    // duplicate, differently-shaped entry in `providers` (Major #4 fix —
    // see llm_gateway::Gateway::provider_statuses's doc comment).
    let providers = json["providers"].as_array().unwrap();
    let names: Vec<&str> = providers
        .iter()
        .map(|p| p["provider"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"anthropic"));
    assert!(names.contains(&"openai"));
    assert!(names.contains(&"gemini"));
    assert!(!names.contains(&"ollama"));
    assert_eq!(providers.len(), 3);
    // ollama's reachability is reported via its own top-level field, not
    // duplicated inside `providers`.
    assert_eq!(json["ollama"]["reachable"], false);
}
