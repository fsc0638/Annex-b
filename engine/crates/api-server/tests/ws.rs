//! `/ws` integration tests (Phase 1 T1.3 acceptance).
//!
//! tower::ServiceExt::oneshot can complete the 101 handshake but cannot
//! drive a duplex WebSocket stream, so these tests bind a real
//! TcpListener on 127.0.0.1:0 and connect with tokio-tungstenite.
//!
//! The world is loaded from the sim-core fixture (no DB), with tick_ms
//! shrunk so ticks arrive fast; assertions use bounded waits, not sleeps.

use std::sync::Arc;
use std::time::Duration;

use api_server::router::build_router;
use api_server::sim::spawn_tick_loop;
use api_server::state::{AppState, SimHandle};
use futures_util::{SinkExt, StreamExt};
use llm_gateway::Gateway;
use sim_core::fixture::load_world_state_from_fixture_files;
use tokio_tungstenite::tungstenite::Message;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Boots a full server (fixture world, fast ticks) on an ephemeral port
/// and returns its address.
async fn spawn_test_server() -> (String, Arc<SimHandle>) {
    let mut world = load_world_state_from_fixture_files().expect("fixture world");
    world.world.tick_ms = 20; // fast wall-clock ticks for tests
    let handle = SimHandle::new(world);
    spawn_tick_loop(handle.clone());

    let state = AppState {
        db: None,
        gateway: Arc::new(Gateway::from_env()),
        sim: Some(handle.clone()),
    };
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("ws://{addr}/ws"), handle)
}

async fn connect(url: &str) -> WsStream {
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");
    stream
}

/// Reads text messages until `pred` matches (bounded by a 5s deadline).
async fn wait_for<F: Fn(&serde_json::Value) -> bool>(
    ws: &mut WsStream,
    pred: F,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
                    if pred(&v) {
                        return v;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("ws closed while waiting: {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for expected ws message")
}

async fn send_json(ws: &mut WsStream, v: serde_json::Value) {
    ws.send(Message::Text(v.to_string())).await.expect("send");
}

/// Reads the next TEXT frame (skipping only protocol frames like
/// ping/pong, never text) so ordering assertions are real — unlike
/// `wait_for`, which scans PAST non-matching text messages.
async fn next_text_frame(ws: &mut WsStream) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str::<serde_json::Value>(&text).expect("valid JSON");
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                other => panic!("expected a text frame, got: {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for a text frame")
}

#[tokio::test]
async fn first_message_is_world_snapshot_with_full_shape() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;

    // The FIRST text frame must be the snapshot — asserted on the first
    // frame directly (spec 7.4 "world_snapshot immediately on connect"),
    // not via a scan that would tolerate other messages sneaking ahead.
    let snap = next_text_frame(&mut ws).await;
    assert_eq!(
        snap["type"], "world_snapshot",
        "the very first text frame must be world_snapshot, got: {snap}"
    );
    assert_eq!(snap["world"]["sim_clock_sec"], 25200, "07:00 kickoff");
    assert_eq!(snap["world"]["speed"], 1);
    assert_eq!(snap["world"]["status"], "paused");
    assert_eq!(snap["agents"].as_array().unwrap().len(), 9);
    assert_eq!(snap["layout"].as_array().unwrap().len(), 94);
    assert_eq!(snap["work_items"].as_array().unwrap().len(), 6);
    // snake_case protocol fields (spec 7.4).
    assert!(snap["agents"][0].get("sprite_key").is_some());
    assert!(snap["layout"][0].get("pos_x").is_some());
}

#[tokio::test]
async fn resume_starts_ticks_pause_broadcasts_world_paused() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws_a = connect(&url).await;
    let mut ws_b = connect(&url).await;
    wait_for(&mut ws_a, |v| v["type"] == "world_snapshot").await;
    wait_for(&mut ws_b, |v| v["type"] == "world_snapshot").await;

    // Paused world: resume from client A -> ticks reach client B too.
    send_json(
        &mut ws_a,
        serde_json::json!({"type": "control", "action": "resume"}),
    )
    .await;
    let tick = wait_for(&mut ws_b, |v| v["type"] == "tick").await;
    assert!(tick["sim_clock_sec"].as_i64().unwrap() > 25200);
    assert_eq!(tick["speed"], 1);

    // Pause from A -> world_paused broadcast reaches B.
    send_json(
        &mut ws_a,
        serde_json::json!({"type": "control", "action": "pause"}),
    )
    .await;
    wait_for(&mut ws_b, |v| v["type"] == "world_paused").await;
}

/// Ordering regression (P1 review minor #4): `world_paused` is sent
/// while holding the world lock — the same serialization point as the
/// tick loop's sends — so no tick stepped before the pause can be
/// enqueued AFTER world_paused. Client impact: a `tick` sets
/// running=true in the store, so a late tick after world_paused would
/// flip every client back to "running" while the world is frozen.
#[tokio::test]
async fn no_tick_arrives_after_world_paused() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;
    wait_for(&mut ws, |v| v["type"] == "world_snapshot").await;

    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "resume"}),
    )
    .await;
    wait_for(&mut ws, |v| v["type"] == "tick").await;
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "pause"}),
    )
    .await;
    wait_for(&mut ws, |v| v["type"] == "world_paused").await;

    // 15+ tick intervals of post-pause silence (tick_ms = 20): nothing
    // may follow world_paused — in particular no tick.
    let late_tick = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
                    if v["type"] == "tick" {
                        return v;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("ws closed during the post-pause window: {other:?}"),
            }
        }
    })
    .await;
    assert!(
        late_tick.is_err(),
        "no tick may arrive after world_paused, got: {late_tick:?}"
    );
}

#[tokio::test]
async fn set_speed_is_validated_and_reflected_in_ticks() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;
    wait_for(&mut ws, |v| v["type"] == "world_snapshot").await;

    // Invalid speed -> per-client error.
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "set_speed", "speed": 3}),
    )
    .await;
    let err = wait_for(&mut ws, |v| v["type"] == "error").await;
    assert!(err["message"].as_str().unwrap().contains("1|2|5"));

    // Valid speed -> next ticks carry it.
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "set_speed", "speed": 5}),
    )
    .await;
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "resume"}),
    )
    .await;
    let tick = wait_for(&mut ws, |v| v["type"] == "tick" && v["speed"] == 5).await;
    assert_eq!(tick["speed"], 5);
}

#[tokio::test]
async fn edit_mode_answers_phase_3_error() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;
    wait_for(&mut ws, |v| v["type"] == "world_snapshot").await;

    for action in ["enter_edit", "exit_edit"] {
        send_json(
            &mut ws,
            serde_json::json!({"type": "control", "action": action}),
        )
        .await;
        let err = wait_for(&mut ws, |v| v["type"] == "error").await;
        assert!(
            err["message"].as_str().unwrap().contains("Phase 3"),
            "{action} must answer a 'Phase 3' error, got: {err}"
        );
    }
}

#[tokio::test]
async fn unknown_types_get_error_replies() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;
    wait_for(&mut ws, |v| v["type"] == "world_snapshot").await;

    send_json(
        &mut ws,
        serde_json::json!({"type": "definitely_not_a_thing"}),
    )
    .await;
    let err = wait_for(&mut ws, |v| v["type"] == "error").await;
    assert!(err["message"]
        .as_str()
        .unwrap()
        .contains("unknown message type"));

    send_json(
        &mut ws,
        serde_json::json!({"type": "inspect", "agent_id": "x"}),
    )
    .await;
    let err = wait_for(&mut ws, |v| v["type"] == "error").await;
    assert!(err["message"].as_str().unwrap().contains("Phase 1"));
}

/// Acceptance: reconnecting (page reload) restores the world from the
/// snapshot alone — including furniture and advanced agent state.
#[tokio::test]
async fn reconnect_snapshot_restores_advanced_world_state() {
    let (url, _handle) = spawn_test_server().await;
    let mut ws = connect(&url).await;
    wait_for(&mut ws, |v| v["type"] == "world_snapshot").await;

    // Run the world until agents are on the floor (skip to 08:30+: VP has
    // spawned and is walking / seated).
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "set_speed", "speed": 5}),
    )
    .await;
    send_json(
        &mut ws,
        serde_json::json!({"type": "control", "action": "resume"}),
    )
    .await;
    let _ = wait_for(&mut ws, |v| {
        v["type"] == "tick" && v["sim_clock_sec"].as_i64().unwrap() >= 30600
    })
    .await;
    // Saw at least one agent_moved along the way? (VP spawns 08:20.)
    // Not asserted here; the reconnect snapshot below is the real check.
    drop(ws); // "page reload"

    let mut ws2 = connect(&url).await;
    let snap = wait_for(&mut ws2, |v| v["type"] == "world_snapshot").await;
    assert!(
        snap["world"]["sim_clock_sec"].as_i64().unwrap() >= 30600,
        "snapshot must reflect the advanced clock"
    );
    assert_eq!(
        snap["world"]["speed"], 5,
        "snapshot must reflect the set speed"
    );
    assert_eq!(
        snap["layout"].as_array().unwrap().len(),
        94,
        "furniture layer fully present after reconnect"
    );
    let agents = snap["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 9);
    let on_floor = agents
        .iter()
        .filter(|a| a["current_status"] != "commuting")
        .count();
    assert!(
        on_floor >= 1,
        "by 08:30+ at least the VP must be on the floor; agents: {agents:?}"
    );
}
