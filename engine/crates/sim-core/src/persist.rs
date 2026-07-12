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

use crate::appearance::validate_appearance;
use crate::llm_profile::validate_llm_profile;
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
    /// ADR-003 D3. `#[serde(default)]` so a save file written before this
    /// field existed still loads (missing → `None`, same "use the
    /// placeholder sprite" meaning as an explicit `null`).
    #[serde(default)]
    pub appearance: Option<serde_json::Value>,
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
                appearance: a.agent.appearance.clone(),
            })
            .collect(),
    }
}

/// Atomically writes (tmp file + rename) the world save file to `path`,
/// creating parent directories as needed. Convenience wrapper that snapshots
/// `ws` and writes in one call; callers that hold a lock over `ws` should
/// instead [`build_save_file`] under the lock, release it, then call
/// [`save_file_to_path`] so the disk I/O never runs under the world lock.
pub fn save_to_path(ws: &WorldState, path: &str) -> std::io::Result<()> {
    save_file_to_path(&build_save_file(ws), path)
}

/// Atomically writes an already-built [`WorldSaveFile`] (tmp file + rename)
/// to `path`, creating parent directories as needed. Split out from
/// [`save_to_path`] so the (lock-free) serialization + disk write can happen
/// after the world lock is released — only the cheap in-memory
/// [`build_save_file`] snapshot needs the lock.
pub fn save_file_to_path(save: &WorldSaveFile, path: &str) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(save).expect("save file always serializes");
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
///
/// When *both* the tmj and the layout changed (a legitimate paired
/// shrink/grow), the single-field `replace_map` then `replace_layout` path
/// cannot be used: `replace_map` would validate the new map against the
/// still-old layout (or vice versa) and reject a pairing that is valid as a
/// whole, dropping the entire save. That case goes through the atomic
/// [`WorldState::replace_map_and_layout`] instead, which validates the new
/// layout against the new map directly. A map+layout change bumps `map_rev`
/// (the map did change); an agent-only or layout-only save does not.
pub fn apply_save_file(base: &WorldState, save: WorldSaveFile) -> Result<WorldState, String> {
    let mut ws = base.clone();
    let map_changed = save.tmj != base.map_json;
    let layout_changed = serde_json::to_value(&save.layout_items).expect("layout serializes")
        != serde_json::to_value(&base.layout).expect("layout serializes");
    match (map_changed, layout_changed) {
        // Paired map+layout change: must be atomic — never validate a new
        // map against the stale layout or a new layout against the stale map.
        (true, true) => ws.replace_map_and_layout(&save.tmj.to_string(), save.layout_items)?,
        // Map only: the layout is unchanged, so validating the new map
        // against the (identical) current layout is correct. Bumps map_rev.
        (true, false) => ws.replace_map(&save.tmj.to_string())?,
        // Layout only (e.g. a `PUT /world/layout`): validate against the
        // unchanged current map. Does not bump map_rev.
        (false, true) => ws.replace_layout(save.layout_items)?,
        // Agent-only save (the common case): touch neither map nor layout,
        // so map_rev is preserved.
        (false, false) => {}
    }
    for ov in save.agents {
        // Loading must apply the same llm_profile validation the API layer
        // uses (a hand-edited save file could otherwise resurrect a profile
        // `PATCH /agents/:id` would have rejected). On failure, warn and drop
        // just this agent's override to defaults ("use tier defaults") —
        // never reject the whole save file for one bad field.
        let llm_profile = match validate_llm_profile(&ov.llm_profile) {
            Ok(()) => ov.llm_profile,
            Err(reason) => {
                tracing::warn!(
                    agent_id = %ov.id,
                    reason = %reason,
                    "world save has an invalid llm_profile override; clearing it for this agent \
                     (other fields and agents are kept)"
                );
                serde_json::json!({})
            }
        };
        // Same defensive-load treatment as llm_profile above: a hand-edited
        // save file could otherwise resurrect an appearance object
        // `PATCH /agents/:id` would have rejected (ADR-003 D3). `None`
        // (no appearance saved) skips validation entirely — nothing to
        // validate, and clearing an already-absent value is a no-op anyway.
        let appearance = match &ov.appearance {
            None => None,
            Some(v) => match validate_appearance(v) {
                Ok(()) => Some(v.clone()),
                Err(reason) => {
                    tracing::warn!(
                        agent_id = %ov.id,
                        reason = %reason,
                        "world save has an invalid appearance override; clearing it for this \
                         agent (other fields and agents are kept)"
                    );
                    None
                }
            },
        };
        ws.patch_agent(
            ov.id,
            AgentPatch {
                name: Some(ov.name),
                seed_traits: Some(ov.seed_traits),
                core_identity: Some(ov.core_identity),
                reply_style: ov.reply_style,
                llm_profile: Some(llm_profile),
                appearance: Some(appearance),
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

    // ---- R1: paired map+layout replace (atomic) -----------------------

    /// A valid ring-of-walls `w x h` tmj with a bottom-center door, sized
    /// for the D2 range (20..=96). Matches the helper in world.rs tests.
    fn ring_tmj(w: i32, h: i32) -> String {
        let (w, h) = (w as usize, h as usize);
        let mut walls = vec![0i64; w * h];
        for y in 0..h {
            for x in 0..w {
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    walls[y * w + x] = 2;
                }
            }
        }
        walls[(h - 1) * w + w / 2] = 0; // door, bottom center
        serde_json::json!({
            "width": w, "height": h,
            "layers": [{"type": "tilelayer", "name": "walls", "data": walls}],
            "tilesets": [{"firstgid": 1, "tiles": [
                {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
            ]}]
        })
        .to_string()
    }

    /// Compacts every layout item to fit inside a `map_w x map_h` room:
    /// items whose footprint already lies within the interior (off the wall
    /// ring) are kept in place; any item that would fall out of bounds is
    /// stacked at the near interior corner (1,1). The 9 fixture agents' desks
    /// and chairs already sit within x∈[2,10], y∈[2,11], so they are never
    /// moved — their one-to-one chair assignment is preserved. Overlaps are
    /// intentional and fine: `validate_layout_within_map` only checks bounds
    /// and map walls, not item-vs-item overlap.
    fn compact_layout(items: &[LayoutItem], map_w: i32, map_h: i32) -> Vec<LayoutItem> {
        items
            .iter()
            .map(|it| {
                let mut it = it.clone();
                let (_, _, fw, fh) = crate::grid::footprint(&it);
                let fits = it.pos_x >= 1
                    && it.pos_y >= 1
                    && it.pos_x + fw < map_w
                    && it.pos_y + fh < map_h;
                if !fits {
                    // Max fixture footprint is 4x3, so (1,1) always fits off
                    // the wall ring for any map >= 20 wide/tall.
                    it.pos_x = 1;
                    it.pos_y = 1;
                }
                it
            })
            .collect()
    }

    /// Reviewer R1(a): start from the 48x32 seed and apply a save that
    /// shrinks BOTH the layout (compacted into 24x24) and the map (24x24)
    /// together. On the old code `apply_save_file` ran `replace_map(24x24)`
    /// first, validating the small new map against the still-48x32 layout
    /// (items out to x=46) — so it failed "outside map bounds" and dropped
    /// the whole save. The atomic path validates the new layout against the
    /// new map, so the paired shrink loads and every item/agent survives.
    #[test]
    fn shrink_layout_and_map_together_preserves_state() {
        let base = fixture_world();
        let mut save = build_save_file(&base);
        save.layout_items = compact_layout(&base.layout, 24, 24);
        save.tmj = serde_json::from_str(&ring_tmj(24, 24)).unwrap();

        let loaded = apply_save_file(&base, save).expect("paired shrink must load, not drop");
        assert_eq!((loaded.map.width, loaded.map.height), (24, 24));
        assert_eq!(loaded.layout.len(), 94, "all 94 layout items preserved");
        assert_eq!(loaded.agents.len(), 9, "all 9 agents preserved");
        assert_eq!(
            loaded.map_rev, 2,
            "a paired map+layout change bumps map_rev"
        );
    }

    /// Reviewer R1(b): grow into a 96-wide map with a layout item at x=50
    /// (out of bounds for the original 48-wide map). The new map is 96x24
    /// (shorter than the original 32-tall), so on the old code
    /// `replace_map(96x24)` — validated against the still-original layout
    /// whose items reach y=30 — failed "outside map bounds" and dropped the
    /// save. The atomic path validates the compacted new layout against the
    /// new map, so the grow loads and the x>47 item survives.
    #[test]
    fn grow_map_and_layout_together_allows_out_of_old_bounds_item() {
        let base = fixture_world();
        let mut save = build_save_file(&base);
        let mut layout = compact_layout(&base.layout, 96, 24);
        let last = layout.len() - 1;
        layout[last].pos_x = 50; // > 47: impossible in the old 48-wide map
        layout[last].pos_y = 1;
        save.layout_items = layout;
        save.tmj = serde_json::from_str(&ring_tmj(96, 24)).unwrap();

        let loaded = apply_save_file(&base, save).expect("paired grow must load, not drop");
        assert_eq!((loaded.map.width, loaded.map.height), (96, 24));
        assert_eq!(loaded.agents.len(), 9);
        assert!(
            loaded.layout.iter().any(|i| i.pos_x == 50),
            "the x>47 item survived the load into the wider map"
        );
    }

    // ---- R3: llm_profile validated on the persist load path -----------

    /// Reviewer R3: a save file whose agent override carries an invalid
    /// `llm_profile` (here an L0 override, which the API layer rejects) must
    /// still load — only that agent's `llm_profile` is cleared to defaults,
    /// every other field and agent is untouched, and the save is not dropped.
    /// On the old code the unvalidated profile was stored verbatim.
    #[test]
    fn invalid_agent_llm_profile_is_cleared_not_rejected() {
        let base = fixture_world();
        let mut save = build_save_file(&base);
        let bad_id = save.agents[0].id;
        let good_id = save.agents[1].id;
        save.agents[0].llm_profile = serde_json::json!({"L0": "ollama:mxbai-embed-large"});
        save.agents[0].reply_style = Some("保留這個欄位".into());
        save.agents[1].llm_profile = serde_json::json!({"L1": "openai:gpt-4o-mini"});

        let loaded = apply_save_file(&base, save).expect("one bad profile must not drop the save");

        let bad = loaded.agent_by_id(bad_id).unwrap();
        assert_eq!(
            bad.agent.llm_profile,
            serde_json::json!({}),
            "invalid llm_profile cleared to defaults"
        );
        assert_eq!(
            bad.agent.reply_style.as_deref(),
            Some("保留這個欄位"),
            "the agent's other fields are untouched"
        );
        let good = loaded.agent_by_id(good_id).unwrap();
        assert_eq!(
            good.agent.llm_profile,
            serde_json::json!({"L1": "openai:gpt-4o-mini"}),
            "a valid override on another agent is preserved as-is"
        );
    }

    // ---- ADR-003 D3: appearance patch/persist roundtrip ----------------

    /// Mirrors `round_trips_through_save_and_load` above, but for
    /// `appearance` instead of `reply_style`.
    #[test]
    fn appearance_round_trips_through_save_and_load() {
        let mut ws = fixture_world();
        let id = ws.agents[0].agent.id;
        let appearance = serde_json::json!({
            "body": "body-01",
            "eyes": "eyes-03",
            "hairstyle": "hairstyle-01-01",
            "outfit": "outfit-05-02",
            "accessory": null
        });
        ws.patch_agent(
            id,
            AgentPatch {
                appearance: Some(Some(appearance.clone())),
                ..Default::default()
            },
        )
        .unwrap();

        let dir =
            std::env::temp_dir().join(format!("sim-core-persist-appearance-{}", Uuid::new_v4()));
        let path = dir.join("world_save.json");
        let path_str = path.to_str().unwrap().to_string();

        save_to_path(&ws, &path_str).expect("save succeeds");
        assert!(path.exists());

        let base = fixture_world();
        let loaded = try_load_and_apply(&base, &path_str)
            .expect("load succeeds")
            .expect("file exists, so Some(..)");
        let loaded_agent = loaded.agents.iter().find(|a| a.agent.id == id).unwrap();
        assert_eq!(loaded_agent.agent.appearance, Some(appearance));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `patch_agent`'s double-Option semantics for `appearance`: providing
    /// `Some(None)` (JSON `null` on the wire) must clear a previously-set
    /// appearance back to `None`, not merely leave it untouched — the field
    /// is a whole-object replace, unlike every other `AgentPatch` field.
    #[test]
    fn patch_agent_can_clear_appearance_back_to_null() {
        let mut ws = fixture_world();
        let id = ws.agents[0].agent.id;
        ws.patch_agent(
            id,
            AgentPatch {
                appearance: Some(Some(serde_json::json!({"body": "body-01"}))),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(ws.agent_by_id(id).unwrap().agent.appearance.is_some());

        ws.patch_agent(
            id,
            AgentPatch {
                appearance: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            ws.agent_by_id(id).unwrap().agent.appearance,
            None,
            "Some(None) (JSON null) must clear appearance, not leave it untouched"
        );
    }

    /// A patch that never mentions `appearance` at all (`AgentPatch::default()`
    /// via `..Default::default()`, i.e. the outer `None`) must leave a
    /// previously-set appearance completely untouched.
    #[test]
    fn patch_agent_omitting_appearance_leaves_it_untouched() {
        let mut ws = fixture_world();
        let id = ws.agents[0].agent.id;
        let appearance = serde_json::json!({"body": "body-02"});
        ws.patch_agent(
            id,
            AgentPatch {
                appearance: Some(Some(appearance.clone())),
                ..Default::default()
            },
        )
        .unwrap();

        ws.patch_agent(
            id,
            AgentPatch {
                reply_style: Some("換個語氣".into()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            ws.agent_by_id(id).unwrap().agent.appearance,
            Some(appearance)
        );
    }

    /// Mirrors `invalid_agent_llm_profile_is_cleared_not_rejected`: a save
    /// file whose agent override carries an invalid `appearance` (unknown
    /// layer key) must still load — only that agent's `appearance` is
    /// cleared to `None`, every other field and agent is untouched.
    #[test]
    fn invalid_agent_appearance_is_cleared_not_rejected() {
        let base = fixture_world();
        let mut save = build_save_file(&base);
        let bad_id = save.agents[0].id;
        let good_id = save.agents[1].id;
        save.agents[0].appearance = Some(serde_json::json!({"hat": "hat-01"}));
        save.agents[0].reply_style = Some("保留這個欄位".into());
        save.agents[1].appearance = Some(serde_json::json!({"body": "body-01"}));

        let loaded =
            apply_save_file(&base, save).expect("one bad appearance must not drop the save");

        let bad = loaded.agent_by_id(bad_id).unwrap();
        assert_eq!(
            bad.agent.appearance, None,
            "invalid appearance cleared to None"
        );
        assert_eq!(
            bad.agent.reply_style.as_deref(),
            Some("保留這個欄位"),
            "the agent's other fields are untouched"
        );
        let good = loaded.agent_by_id(good_id).unwrap();
        assert_eq!(
            good.agent.appearance,
            Some(serde_json::json!({"body": "body-01"})),
            "a valid override on another agent is preserved as-is"
        );
    }
}
