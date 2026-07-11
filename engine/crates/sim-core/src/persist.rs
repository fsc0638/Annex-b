//! Fixture-mode persistence (ADR-002 D3).
//!
//! In `WORLD_SOURCE=fixture` mode (no database), any successful
//! `PUT /world/map`, `PUT /world/layout`, or `PATCH /agents/:id` mutation
//! is atomically written to `WORLD_SAVE_PATH` so a server restart resumes
//! the edited world instead of reverting to the seed fixture every time.
//!
//! Loading is deliberately defensive: [`apply_save_file`] only ever
//! mutates a *clone* of the base world through the same public,
//! self-validating methods the REST handlers use
//! (`WorldState::replace_map` / `replace_layout` / `patch_agent`), so it
//! can never resurrect an invalid world. On any failure — file missing,
//! corrupt JSON, or a validation error (e.g. the base fixture's tmj/layout
//! changed shape since the save file was written) — the caller keeps using
//! the original fixture world untouched and just logs a WARN (D3: "損壞→
//! tracing WARN 忽略").

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::world::{AgentPatch, WorldState};
use crate::LayoutItem;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSaveFile {
    pub tmj: serde_json::Value,
    pub layout_items: Vec<LayoutItem>,
    pub agents: Vec<AgentOverride>,
}

/// The subset of `agents` fields that are user-editable via `PATCH
/// /api/v1/agents/:id` (ADR-002 D5) — everything else (position, current
/// status, desk assignment, …) is simulation-runtime state that a fresh
/// day-start reset already re-derives, so it is intentionally not saved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOverride {
    pub id: Uuid,
    pub name: String,
    pub seed_traits: String,
    pub core_identity: String,
    pub reply_style: Option<String>,
    pub llm_profile: serde_json::Value,
}

/// Compile-time default resolves relative to this crate's manifest dir,
/// matching the ADR-002 D3 default (`{repo}/data/world_save.json`). In
/// containers/deployments, set `WORLD_SAVE_PATH` explicitly.
pub fn default_save_path() -> String {
    format!(
        "{}/../../../data/world_save.json",
        env!("CARGO_MANIFEST_DIR")
    )
}

pub fn save_path_from_env() -> String {
    std::env::var("WORLD_SAVE_PATH").unwrap_or_else(|_| default_save_path())
}

pub fn build_save_file(ws: &WorldState) -> WorldSaveFile {
    WorldSaveFile {
        tmj: ws.map_json.clone(),
        layout_items: ws.layout.clone(),
        agents: ws
            .agents
            .iter()
            .map(|a| AgentOverride {
                id: a.agent.id,
                name: a.agent.name.clone(),
                seed_traits: a.agent.seed_traits.clone(),
                core_identity: a.agent.core_identity.clone(),
                reply_style: a.agent.reply_style.clone(),
                llm_profile: a.agent.llm_profile.clone(),
            })
            .collect(),
    }
}

/// Atomically writes (tmp file + rename) the world save file to `path`,
/// creating parent directories as needed.
pub fn save_to_path(ws: &WorldState, path: &str) -> std::io::Result<()> {
    let save = build_save_file(ws);
    let json = serde_json::to_string_pretty(&save).expect("save file always serializes");
    let path_ref = std::path::Path::new(path);
    if let Some(parent) = path_ref.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_path = format!("{path}.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

/// Applies a parsed save file on top of `base`, returning a new,
/// fully-validated `WorldState` on success. Never partially mutates —
/// either every step (`replace_map`, `replace_layout`, every agent
/// `patch_agent`) succeeds, or the whole thing is discarded and an `Err`
/// is returned with `base` conceptually untouched (the caller never sees
/// the intermediate clone).
///
/// `replace_map`/`replace_layout` are skipped entirely when the saved tmj/
/// layout are byte-for-byte identical to `base`'s (the common case: most
/// saves come from a `PATCH /agents/:id` that never touched the map or
/// layout). This matters because `replace_map` unconditionally bumps
/// `map_rev` — without this check, every server restart would bump
/// `map_rev` even when no `PUT /world/map` ever happened, misleading a
/// client that treats `map_rev` as "the map itself changed".
pub fn apply_save_file(base: &WorldState, save: WorldSaveFile) -> Result<WorldState, String> {
    let mut ws = base.clone();
    if save.tmj != base.map_json {
        ws.replace_map(&save.tmj.to_string())?;
    }
    let layout_changed = serde_json::to_value(&save.layout_items).expect("layout serializes")
        != serde_json::to_value(&base.layout).expect("layout serializes");
    if layout_changed {
        ws.replace_layout(save.layout_items)?;
    }
    for ov in save.agents {
        ws.patch_agent(
            ov.id,
            AgentPatch {
                name: Some(ov.name),
                seed_traits: Some(ov.seed_traits),
                core_identity: Some(ov.core_identity),
                reply_style: ov.reply_style,
                llm_profile: Some(ov.llm_profile),
            },
        )?;
    }
    Ok(ws)
}

/// Reads + parses + applies the save file at `path` on top of `base`.
/// Returns `Ok(None)` when the file simply does not exist yet (the normal
/// first-boot case — not a warning-worthy condition), `Ok(Some(world))` on
/// a successfully-applied save, and `Err` for anything that should be
/// logged as a WARN (missing-but-stat-failed, corrupt JSON, or a
/// validation failure against the current base world).
pub fn try_load_and_apply(base: &WorldState, path: &str) -> Result<Option<WorldState>, String> {
    if !std::path::Path::new(path).exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let save: WorldSaveFile = serde_json::from_str(&text)
        .map_err(|e| format!("invalid world save JSON in {path}: {e}"))?;
    apply_save_file(base, save).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::load_world_state_from_fixture_files;

    fn fixture_world() -> WorldState {
        load_world_state_from_fixture_files().expect("fixture world loads")
    }

    #[test]
    fn round_trips_through_save_and_load() {
        let mut ws = fixture_world();
        // Mutate one agent's editable fields so the round trip is
        // observable (not just "identical file back out").
        let id = ws.agents[0].agent.id;
        ws.patch_agent(
            id,
            AgentPatch {
                reply_style: Some("測試回覆風格".into()),
                ..Default::default()
            },
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("sim-core-persist-test-{}", Uuid::new_v4()));
        let path = dir.join("world_save.json");
        let path_str = path.to_str().unwrap().to_string();

        save_to_path(&ws, &path_str).expect("save succeeds");
        assert!(path.exists());

        let base = fixture_world(); // fresh, unmutated base (simulates a restart)
        let loaded = try_load_and_apply(&base, &path_str)
            .expect("load succeeds")
            .expect("file exists, so Some(..)");
        let loaded_agent = loaded.agents.iter().find(|a| a.agent.id == id).unwrap();
        assert_eq!(
            loaded_agent.agent.reply_style.as_deref(),
            Some("測試回覆風格")
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression: applying a save file whose map/layout are unchanged
    /// from `base` (the common case — a save produced by a `PATCH
    /// /agents/:id` that never touched the map/layout) must not bump
    /// `map_rev`. Before this behavior existed, `apply_save_file`
    /// unconditionally called `replace_map` (which always increments
    /// `map_rev`), so every server restart bumped `map_rev` even with no
    /// `PUT /world/map` ever having happened.
    #[test]
    fn agent_only_save_does_not_bump_map_rev_or_touch_layout() {
        let mut ws = fixture_world();
        let id = ws.agents[0].agent.id;
        ws.patch_agent(
            id,
            AgentPatch {
                reply_style: Some("僅角色變更".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(ws.map_rev, 1, "PATCH must never touch map_rev");

        let dir = std::env::temp_dir().join(format!("sim-core-persist-maprev-{}", Uuid::new_v4()));
        let path = dir.join("world_save.json");
        let path_str = path.to_str().unwrap().to_string();
        save_to_path(&ws, &path_str).expect("save succeeds");

        let base = fixture_world();
        assert_eq!(base.map_rev, 1);
        let loaded = try_load_and_apply(&base, &path_str)
            .expect("load succeeds")
            .expect("file exists, so Some(..)");

        assert_eq!(
            loaded.map_rev, 1,
            "an agent-only save must not bump map_rev on load"
        );
        assert_eq!(loaded.layout.len(), base.layout.len());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_yields_ok_none() {
        let base = fixture_world();
        let result = try_load_and_apply(&base, "/nonexistent/path/does-not-exist.json").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn corrupt_file_yields_err_without_panicking() {
        let base = fixture_world();
        let dir = std::env::temp_dir().join(format!("sim-core-persist-corrupt-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("world_save.json");
        std::fs::write(&path, "not valid json").unwrap();

        let err = try_load_and_apply(&base, path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("invalid world save JSON"), "{err}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
