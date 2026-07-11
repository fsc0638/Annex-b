use axum::http::{HeaderValue, Method};
use axum::routing::{get, patch, put};
use axum::Router;
use tower_http::cors::CorsLayer;

use crate::agents_api::patch_agent;
use crate::healthz::healthz;
use crate::state::AppState;
use crate::world_api::{get_map, put_layout, put_map};
use crate::ws::ws_handler;

/// Builds the axum router. Phase 1: `GET /api/v1/healthz` and the `/ws`
/// WebSocket (spec 7.4). ADR-002 D2/D5 (Phase 3 前置) adds the world
/// configuration REST surface consumed by the layout editor / agent panel.
///
/// CORS: the web dev server runs on `:3000`, api-server on `:8080` — a
/// browser fetch from the editor is cross-origin. `/ws` doesn't need CORS
/// (the WebSocket handshake isn't subject to the same-origin policy the
/// same way `fetch`/`XHR` are), so the layer only wraps the REST surface,
/// not the whole router.
pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin("http://localhost:3000".parse::<HeaderValue>().unwrap())
        .allow_methods([Method::GET, Method::PUT, Method::PATCH, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any);

    let rest = Router::new()
        .route("/api/v1/healthz", get(healthz))
        .route("/api/v1/world/map", get(get_map).put(put_map))
        .route("/api/v1/world/layout", put(put_layout))
        .route("/api/v1/agents/:id", patch(patch_agent))
        .layer(cors);

    Router::new()
        .merge(rest)
        .route("/ws", get(ws_handler))
        .with_state(state)
}
