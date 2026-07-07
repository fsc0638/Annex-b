use std::sync::Arc;

use api_server::{router, state::AppState};
use llm_gateway::Gateway;
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env if present; harmless no-op if absent (e.g. in compose where
    // env is injected directly).
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let gateway = Arc::new(Gateway::from_env());

    let db = match std::env::var("DATABASE_URL") {
        Ok(url) => match PgPoolOptions::new().max_connections(5).connect(&url).await {
            Ok(pool) => {
                tracing::info!("connected to database");
                Some(pool)
            }
            Err(e) => {
                tracing::warn!(error = %e, "failed to connect to database at startup; healthz will report db as unreachable");
                None
            }
        },
        Err(_) => {
            tracing::warn!("DATABASE_URL not set; healthz will report db as unreachable");
            None
        }
    };

    let state = AppState { db, gateway };
    let app = router::build_router(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "api-server listening");
    axum::serve(listener, app).await?;

    Ok(())
}
