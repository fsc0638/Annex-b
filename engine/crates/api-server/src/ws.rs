//! `GET /ws` — WebSocket protocol (spec 7.4, Phase 1 subset).
//!
//! Server -> Client: `world_snapshot` immediately on connect, then the
//! broadcast stream (`tick` / `agent_moved` / `agent_status` /
//! `world_paused`). Client -> Server: `control` with action
//! pause|resume|set_speed; `enter_edit`/`exit_edit` answer an explicit
//! "Phase 3" error instead of being silently ignored. Unknown or
//! not-yet-supported message types get an `error` reply on the same
//! socket (errors are per-client; they are never broadcast).
//!
//! Lag policy: a client that falls behind the broadcast channel
//! (RecvError::Lagged) is disconnected instead of resuming mid-stream
//! with a gap — its reconnect fetches a fresh, consistent snapshot.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::sink::SinkExt;
use futures_util::stream::{SplitSink, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::state::{AppState, SimHandle};

pub async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    match state.sim {
        Some(sim) => ws.on_upgrade(move |socket| client_session(socket, sim)),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "world not loaded (check WORLD_SOURCE / DATABASE_URL)",
        )
            .into_response(),
    }
}

async fn client_session(socket: WebSocket, sim: Arc<SimHandle>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe BEFORE taking the snapshot so no event can fall between
    // snapshot and subscription; events that raced the snapshot are
    // harmless replays (position/status sets are idempotent client-side).
    let mut rx = sim.events.subscribe();
    let snapshot = {
        let world = sim.world.lock().await;
        world.snapshot_json().to_string()
    };
    if sender.send(Message::Text(snapshot)).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            broadcast = rx.recv() => match broadcast {
                Ok(event_json) => {
                    if sender.send(Message::Text(event_json)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "ws client lagged; disconnecting for fresh snapshot");
                    break;
                }
                Err(RecvError::Closed) => break,
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if handle_client_message(&sim, &text, &mut sender).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {} // ping/pong/binary: ignore
                Some(Err(_)) => break,
            },
        }
    }
}

type WsSender = SplitSink<WebSocket, Message>;

async fn send_error(sender: &mut WsSender, message: &str) -> Result<(), ()> {
    let payload = json!({ "type": "error", "message": message }).to_string();
    sender.send(Message::Text(payload)).await.map_err(|_| ())
}

/// Handles one Client -> Server message. Returns Err(()) only when the
/// socket is dead (caller then ends the session).
async fn handle_client_message(
    sim: &Arc<SimHandle>,
    text: &str,
    sender: &mut WsSender,
) -> Result<(), ()> {
    let Ok(msg) = serde_json::from_str::<Value>(text) else {
        return send_error(sender, "invalid JSON").await;
    };
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("control") => handle_control(sim, &msg, sender).await,
        Some("inspect") | Some("visitor_message") | Some("create_work_item") => {
            send_error(sender, "not supported yet in Phase 1").await
        }
        Some(other) => send_error(sender, &format!("unknown message type '{other}'")).await,
        None => send_error(sender, "missing 'type' field").await,
    }
}

async fn handle_control(
    sim: &Arc<SimHandle>,
    msg: &Value,
    sender: &mut WsSender,
) -> Result<(), ()> {
    match msg.get("action").and_then(|a| a.as_str()) {
        Some("pause") => {
            // Spec 7.4 world_paused: broadcast so every client freezes
            // together (resume is observable via ticks starting again).
            //
            // The broadcast is sent WHILE the world lock is held — the
            // tick loop (sim.rs) also sends its events under this lock,
            // so the channel order is fully serialized by the lock:
            // world_paused always lands after every tick that preceded
            // the pause, and no tick can slip in between pause() and
            // this send. (Previously the send happened after unlocking,
            // so an already-stepped tick could be enqueued AFTER
            // world_paused, making clients flip back to running.)
            {
                let mut world = sim.world.lock().await;
                world.pause();
                let _ = sim
                    .events
                    .send(json!({ "type": "world_paused" }).to_string());
            }
            Ok(())
        }
        Some("resume") => {
            let mut world = sim.world.lock().await;
            world.resume();
            Ok(())
        }
        Some("set_speed") => {
            let Some(speed) = msg.get("speed").and_then(|s| s.as_u64()) else {
                return send_error(sender, "set_speed requires a numeric 'speed' field (1|2|5)")
                    .await;
            };
            let result = {
                let mut world = sim.world.lock().await;
                world.set_speed(speed as u32)
            };
            match result {
                Ok(()) => Ok(()),
                Err(e) => send_error(sender, &e).await,
            }
        }
        // Layout edit mode is Phase 3 scope (spec 7.3); answer loudly so
        // the UI can tell the user instead of appearing broken.
        Some("enter_edit") | Some("exit_edit") => {
            send_error(sender, "edit mode is not implemented until Phase 3").await
        }
        Some(other) => send_error(sender, &format!("unknown control action '{other}'")).await,
        None => send_error(sender, "control requires an 'action' field").await,
    }
}
