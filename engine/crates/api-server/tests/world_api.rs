//! `GET/PUT /api/v1/world/map` and `PUT /api/v1/world/layout` integration
//! tests (ADR-002 D2 acceptance: each endpoint gets a success case and at
//! least one validation-failure case), driven with
//! `tower::ServiceExt::oneshot` — no real TCP socket needed for a plain
//! HTTP request/response cycle (unlike `/ws`, see tests/ws.rs).
//!
//! The map PUT tests use a small synthetic TMJ built in-process (NOT the
//! JS generator's output — task instruction) sized 20/24x20, matching
//! ADR-002 D2's 20..=96 range, paired with a matching small layout (the
//! full 94-item office fixture wouldn't fit a 20x20 test map).

use std::sync::Arc;

use api_server::router::build_router;
use api_server::state::{AppState, SimHandle};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use llm_gateway::Gateway;
use sim_core::world::WorldState;
use sim_core::{Agent, LayoutItem, LayoutItemKind, World, WorldStatus};
use tower::ServiceExt;
use uuid::Uuid;

/// `std::env::set_var("WORLD_SAVE_PATH", ..)` is process-global but
/// `cargo test` runs the `#[tokio::test]` functions in this file
/// concurrently on multiple threads — any test that lets a handler read
/// `WORLD_SAVE_PATH` (i.e. any successful mutation, which triggers
/// fixture-mode persistence) must hold this lock for its full
/// set-env/request/assert span, mirroring llm-gateway's own `ENV_MUTEX`
/// convention (crates/llm-gateway/src/lib.rs). `tokio::sync::Mutex` (not
/// `std::sync::Mutex`) because the guard is held across `.await` points.
static ENV_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn ring_tmj(w: i32, h: i32) -> serde_json::Value {
    let (wu, hu) = (w as usize, h as usize);
    let mut walls = vec![0i64; wu * hu];
    for y in 0..hu {
        for x in 0..wu {
            if x == 0 || y == 0 || x == wu - 1 || y == hu - 1 {
                walls[y * wu + x] = 2;
            }
        }
    }
    walls[(hu - 1) * wu + wu / 2] = 0; // door, bottom center
    serde_json::json!({
        "width": w, "height": h,
        "layers": [{"type": "tilelayer", "name": "walls", "data": walls}],
        "tilesets": [{"firstgid": 1, "tiles": [
            {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
        ]}]
    })
}

fn tiny_agent(name: &str, desk_id: Uuid) -> Agent {
    Agent {
        id: Uuid::new_v4(),
        world_id: Uuid::nil(),
        name: name.into(),
        sprite_key: "agent_x".into(),
        grade: "專員".into(),
        title: "t".into(),
        reports_to: None,
        core_identity: "t".into(),
        seed_traits: "t".into(),
        reply_style: None,
        current_status: "commuting".into(),
        pos_x: 0,
        pos_y: 0,
        desk_id: Some(desk_id),
        llm_profile: serde_json::json!({}),
    }
}

fn tiny_layout_item(
    id: Uuid,
    kind: LayoutItemKind,
    key: &str,
    x: i32,
    y: i32,
    walkable: bool,
) -> LayoutItem {
    LayoutItem {
        id,
        world_id: Uuid::nil(),
        kind,
        key: key.into(),
        name: key.into(),
        pos_x: x,
        pos_y: y,
        w: 1,
        h: 1,
        rotation: 0,
        zone: "common".into(),
        walkable,
        affords: vec![],
        meta: serde_json::Value::Null,
    }
}

/// A minimal but valid world: one agent, one desk+chair, on a 20x20 ring
/// map — small enough that both the "in range" and "still fits" branches
/// of `replace_map`'s validation are easy to exercise deliberately.
fn small_world() -> WorldState {
    let world = World {
        id: Uuid::new_v4(),
        name: "test world".into(),
        seed: 1,
        sim_day: 1,
        sim_clock_sec: sim_core::clock::game_secs(7, 0),
        tick_ms: 1000,
        sec_per_tick: 10,
        status: WorldStatus::Paused,
    };
    let desk_id = Uuid::new_v4();
    let layout = vec![
        tiny_layout_item(desk_id, LayoutItemKind::Desk, "deskA", 2, 2, false),
        tiny_layout_item(
            Uuid::new_v4(),
            LayoutItemKind::Chair,
            "deskA-chair",
            2,
            3,
            true,
        ),
    ];
    let agents = vec![tiny_agent("甲", desk_id)];
    WorldState::from_parts(world, agents, layout, vec![], &ring_tmj(20, 20).to_string())
        .expect("valid small test world")
}

fn test_state(world: WorldState) -> (AppState, Arc<SimHandle>) {
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

/// Points `WORLD_SAVE_PATH` at a fresh, isolated tmp file so a successful
/// mutation's fixture-mode persistence write never touches the real repo
/// path (`{repo}/data/world_save.json`). Caller must hold `ENV_MUTEX`.
fn point_world_save_path_at_tmp() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("api-server-world-api-test-{}", Uuid::new_v4()));
    let path = dir.join("world_save.json");
    std::env::set_var("WORLD_SAVE_PATH", &path);
    path
}

#[tokio::test]
async fn get_map_returns_current_tmj_and_rev() {
    let (state, _handle) = test_state(small_world());
    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/world/map")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["map_rev"], 1);
    assert_eq!(json["tmj"]["width"], 20);
    assert_eq!(json["tmj"]["height"], 20);
}

#[tokio::test]
async fn put_map_replaces_map_bumps_rev_and_broadcasts_snapshot() {
    let _guard = ENV_MUTEX.lock().await;
    let tmp_path = point_world_save_path_at_tmp();

    let (state, handle) = test_state(small_world());
    let mut rx = handle.events.subscribe();
    let app = build_router(state);

    let body = serde_json::json!({ "tmj": ring_tmj(24, 20) }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/world/map")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["world"]["map_rev"], 2);
    assert_eq!(json["world"]["status"], "paused");
    assert_eq!(
        json["world"]["sim_clock_sec"], 25200,
        "reset to 07:00 kickoff"
    );

    // A full world_snapshot was broadcast on the same channel /ws uses.
    let broadcast = rx.try_recv().expect("a snapshot was broadcast");
    let v: serde_json::Value = serde_json::from_str(&broadcast).unwrap();
    assert_eq!(v["type"], "world_snapshot");
    assert_eq!(v["world"]["map_rev"], 2);

    // Fixture-mode persistence actually wrote a save file.
    assert!(
        tmp_path.exists(),
        "PUT /world/map must persist the fixture save file"
    );
    std::fs::remove_dir_all(tmp_path.parent().unwrap()).ok();
}

#[tokio::test]
async fn put_map_rejects_out_of_range_size_with_422() {
    let (state, handle) = test_state(small_world());
    let app = build_router(state);
    let body = serde_json::json!({ "tmj": ring_tmj(10, 10) }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/world/map")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let json = body_json(response).await;
    assert_eq!(json["error"]["code"], "validation_failed");
    assert!(json["error"]["message"].as_str().unwrap().contains("20"));

    // Rejected: map_rev must not have moved.
    let world = handle.world.lock().await;
    assert_eq!(world.map_rev, 1);
}

#[tokio::test]
async fn put_layout_replaces_layout_and_broadcasts_snapshot() {
    let _guard = ENV_MUTEX.lock().await;
    let tmp_path = point_world_save_path_at_tmp();

    let (state, handle) = test_state(small_world());
    let mut rx = handle.events.subscribe();
    let app = build_router(state);

    let desk_id = {
        let world = handle.world.lock().await;
        world
            .layout
            .iter()
            .find(|l| l.kind == LayoutItemKind::Desk)
            .unwrap()
            .id
    };
    let items = vec![
        tiny_layout_item(desk_id, LayoutItemKind::Desk, "deskA", 3, 3, false),
        tiny_layout_item(
            Uuid::new_v4(),
            LayoutItemKind::Chair,
            "deskA-chair",
            3,
            4,
            true,
        ),
    ];
    let body = serde_json::json!({ "items": items }).to_string();

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/world/layout")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["layout"].as_array().unwrap().len(), 2);
    assert_eq!(json["layout"][0]["pos_x"], 3);

    let broadcast = rx.try_recv().expect("a snapshot was broadcast");
    let v: serde_json::Value = serde_json::from_str(&broadcast).unwrap();
    assert_eq!(v["type"], "world_snapshot");

    assert!(
        tmp_path.exists(),
        "PUT /world/layout must persist the fixture save file"
    );
    std::fs::remove_dir_all(tmp_path.parent().unwrap()).ok();
}

#[tokio::test]
async fn put_layout_rejects_when_agent_desk_missing_with_422() {
    let (state, handle) = test_state(small_world());
    let app = build_router(state);

    let body = serde_json::json!({ "items": Vec::<LayoutItem>::new() }).to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/world/layout")
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
        .contains("not in layout"));

    let world = handle.world.lock().await;
    assert_eq!(
        world.layout.len(),
        2,
        "a rejected PUT must not mutate the layout"
    );
}

#[tokio::test]
async fn world_endpoints_answer_503_when_world_not_loaded() {
    let state = AppState {
        db: None,
        gateway: Arc::new(Gateway::from_env()),
        sim: None,
    };
    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/world/map")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}
