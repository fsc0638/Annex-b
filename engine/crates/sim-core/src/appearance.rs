//! Shared validation for `agents.appearance` overrides (ADR-003 D3).
//!
//! `appearance` is a sim-core domain field (`Agent::appearance`), so — same
//! rationale as `llm_profile.rs` — the single source of truth for "what is
//! a valid appearance object" lives here, next to the type. Both entry
//! points that accept user/save-file data call [`validate_appearance`]:
//! - api-server's `PATCH /api/v1/agents/:id` handler (maps the `Err`
//!   message into its 422 JSON envelope), and
//! - the fixture-mode persist load path (`persist::apply_save_file`), so a
//!   hand-edited save file can't resurrect an appearance the API layer
//!   would have rejected.
//!
//! Rules (ADR-003 D3): the value must be a JSON object; every key must be
//! one of the five known layers (`body`/`eyes`/`hairstyle`/`outfit`/
//! `accessory`); every value must be either a JSON string (a
//! `web/public/character/<layer>/<id>.png` piece id — this module does not
//! check the id exists on disk, since sim-core has no filesystem/HTTP
//! access to the browser-served character manifest) or JSON `null` ("no
//! piece on this layer"). `appearance` itself may also be JSON `null`
//! ("use the generated placeholder sprite, ignore all layers") — that case
//! is handled by the caller before reaching this function (see
//! `AgentPatch::appearance`'s double-Option shape in `world.rs`), so this
//! function itself only ever validates a *present* (non-null) object.

use serde_json::Value;

/// Every valid `appearance` object key (ADR-003 D3 layer names — mirrors
/// `web/public/character/manifest.json`'s `layers` keys, produced by
/// `scripts/sync_character_pieces.mjs`).
const KNOWN_LAYERS: &[&str] = &["body", "eyes", "hairstyle", "outfit", "accessory"];

/// Validates one non-null `appearance` value. Returns a human-readable
/// error message on the first rule violation (the api-server handler wraps
/// it into a 422 envelope; the persist load path logs it as a WARN and
/// clears just that agent's appearance to `null`).
pub fn validate_appearance(v: &Value) -> Result<(), String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "appearance must be a JSON object or null".to_string())?;
    for (key, val) in obj {
        if !KNOWN_LAYERS.contains(&key.as_str()) {
            return Err(format!(
                "appearance: unknown layer key '{key}' (allowed: {})",
                KNOWN_LAYERS.join(", ")
            ));
        }
        if !val.is_string() && !val.is_null() {
            return Err(format!(
                "appearance.{key} must be a string (piece id) or null, got {val}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_empty_object_and_full_valid_object() {
        assert!(validate_appearance(&json!({})).is_ok());
        assert!(validate_appearance(&json!({
            "body": "body-01",
            "eyes": "eyes-03",
            "hairstyle": "hairstyle-01-01",
            "outfit": "outfit-05-02",
            "accessory": null
        }))
        .is_ok());
    }

    #[test]
    fn accepts_partial_object_with_only_some_layers() {
        assert!(validate_appearance(&json!({"body": "body-02"})).is_ok());
    }

    #[test]
    fn rejects_unknown_layer_key() {
        let err = validate_appearance(&json!({"hat": "hat-01"})).unwrap_err();
        assert!(err.contains("hat"), "{err}");
    }

    #[test]
    fn rejects_non_string_non_null_value() {
        let err = validate_appearance(&json!({"body": 42})).unwrap_err();
        assert!(err.contains("body"), "{err}");
    }

    #[test]
    fn rejects_non_object() {
        assert!(validate_appearance(&json!("body-01")).is_err());
        assert!(validate_appearance(&json!(["body-01"])).is_err());
    }
}
