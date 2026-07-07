//! JSON output guard (spec 6.1: "JSON 輸出統一防護（剝 fence → serde →
//! 失敗重試一次 → 再失敗降級 continue）"). Phase 0 scope: the pure
//! fence-stripping + parse step, unit-testable without any network calls.
//! The retry-once-then-degrade orchestration belongs to the async call site
//! (agent-core, Phase 2) since it needs to re-invoke the LLM.

/// Strips a markdown code fence (```json ... ``` or ``` ... ```) if present,
/// then attempts to parse the remainder as JSON. Returns `None` if parsing
/// fails after stripping — callers are expected to retry once and then
/// degrade (per spec) rather than this function retrying itself.
pub fn strip_fence_and_parse(raw: &str) -> Option<serde_json::Value> {
    let stripped = strip_fence(raw);
    serde_json::from_str(stripped.trim()).ok()
}

/// Pure helper: removes a leading/trailing triple-backtick fence, with or
/// without a language tag, if the string is wrapped in one. Leaves the
/// input unchanged (aside from trimming) if no fence is detected.
fn strip_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        // Skip an optional language tag on the first line (e.g. "json").
        let after_tag = match rest.find('\n') {
            Some(idx) => &rest[idx + 1..],
            None => rest,
        };
        let without_trailing = after_tag.strip_suffix("```").unwrap_or(after_tag);
        return without_trailing.trim();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_bare_json() {
        let out = strip_fence_and_parse(r#"{"a": 1}"#).unwrap();
        assert_eq!(out, json!({"a": 1}));
    }

    #[test]
    fn strips_json_language_tagged_fence() {
        let raw = "```json\n{\"a\": 1}\n```";
        let out = strip_fence_and_parse(raw).unwrap();
        assert_eq!(out, json!({"a": 1}));
    }

    #[test]
    fn strips_bare_fence_no_language_tag() {
        let raw = "```\n{\"a\": 1}\n```";
        let out = strip_fence_and_parse(raw).unwrap();
        assert_eq!(out, json!({"a": 1}));
    }

    #[test]
    fn handles_surrounding_whitespace() {
        let raw = "  \n  {\"a\": 1}  \n  ";
        let out = strip_fence_and_parse(raw).unwrap();
        assert_eq!(out, json!({"a": 1}));
    }

    #[test]
    fn returns_none_on_unparseable_content() {
        let out = strip_fence_and_parse("this is not json at all");
        assert!(out.is_none());
    }

    #[test]
    fn parses_json_array() {
        let raw = "```json\n[{\"time\":\"09:00\"}]\n```";
        let out = strip_fence_and_parse(raw).unwrap();
        assert!(out.is_array());
    }
}
