//! Anti-drift guard (Phase 1 T1.2 requirement): the world fixture JSON
//! must agree with scripts/check_seed_counts.sh's expected counts. The
//! shell script asserts seed_world.sh's literal SQL; this test asserts the
//! fixture; together they pin fixture <-> seed script <-> DB seed to the
//! same numbers, so none can drift silently.
//!
//! The expected numbers are PARSED out of check_seed_counts.sh's own
//! `check_count` lines rather than duplicated here.

use std::collections::HashMap;

use sim_core::fixture::parse_fixture;

fn read_repo_file(rel: &str) -> String {
    let path = format!("{}/{}", env!("CARGO_MANIFEST_DIR"), rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

/// Parses `check_count "<label>" "$VAR" <expected>` lines.
fn parse_expected_counts(script: &str) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    for line in script.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("check_count \"") else {
            continue;
        };
        let Some(label_end) = rest.find('"') else {
            continue;
        };
        let label = &rest[..label_end];
        let Some(num) = rest.rsplit(' ').next().and_then(|n| n.parse::<i64>().ok()) else {
            continue;
        };
        out.insert(label.to_string(), num);
    }
    out
}

#[test]
fn fixture_counts_match_check_seed_counts_sh() {
    let script = read_repo_file("../../../scripts/check_seed_counts.sh");
    let expected = parse_expected_counts(&script);
    assert!(
        expected.len() >= 12,
        "check_seed_counts.sh parse produced too few rules: {expected:?}"
    );

    let fixture_json = read_repo_file("tests/fixtures/world_fixture.json");
    let fx = parse_fixture(&fixture_json).expect("fixture parses");

    // layout_items per-kind counts.
    let mut kind_counts: HashMap<&'static str, i64> = HashMap::new();
    for item in &fx.layout {
        *kind_counts.entry(item.kind.as_db_str()).or_insert(0) += 1;
    }
    for (label, want) in &expected {
        if let Some(kind) = label.strip_prefix("layout_items.") {
            let got = kind_counts.get(kind).copied().unwrap_or(0);
            assert_eq!(
                got, *want,
                "fixture layout kind '{kind}': {got} != check_seed_counts.sh expectation {want}"
            );
        }
    }

    // agents / work_items totals.
    let agents_expected = expected
        .get("agents (insert blocks)")
        .copied()
        .expect("agents rule present");
    assert_eq!(fx.agents.len() as i64, agents_expected);
    let work_expected = expected
        .get("work_items")
        .copied()
        .expect("work_items rule present");
    assert_eq!(fx.work_items.len() as i64, work_expected);

    // Total layout rows = sum of all per-kind expectations.
    let layout_total: i64 = expected
        .iter()
        .filter(|(k, _)| k.starts_with("layout_items."))
        .map(|(_, v)| *v)
        .sum();
    assert_eq!(fx.layout.len() as i64, layout_total, "fixture layout total");
}

#[test]
fn fixture_seat_assignments_match_seed_seat_map() {
    // seat_map in seed_world.sh is the source of truth for who sits where;
    // the fixture must agree (desk key referenced by each agent's desk_id).
    let fixture_json = read_repo_file("tests/fixtures/world_fixture.json");
    let fx = parse_fixture(&fixture_json).unwrap();
    let expected: &[(&str, &str)] = &[
        ("方以寧", "exec.vp"),
        ("高子軒", "exec.mgr"),
        ("沈書萍", "deskA-01"),
        ("郭立衡", "deskA-02"),
        ("曾若彤", "deskA-03"),
        ("韓致遠", "deskA-04"),
        ("廖苡安", "deskA-05"),
        ("江秉倫", "deskA-06"),
        ("阮曉青", "deskA-08"),
    ];
    for (name, desk_key) in expected {
        let agent = fx
            .agents
            .iter()
            .find(|a| a.name == *name)
            .unwrap_or_else(|| panic!("agent {name} missing from fixture"));
        let desk = fx
            .layout
            .iter()
            .find(|l| Some(l.id) == agent.desk_id)
            .unwrap_or_else(|| panic!("desk of {name} missing"));
        assert_eq!(&desk.key, desk_key, "seat of {name}");
    }
}
