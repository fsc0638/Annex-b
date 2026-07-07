//! Integration tests against the REAL generated map + fixture (Phase 1
//! T1.1/T1.2 acceptance): office_shell.tmj structure, door-to-everywhere
//! connectivity (spec 7.3 rule 2 applied to the default layout), and the
//! office-map A* golden path (spec 10.1).

use std::collections::HashSet;

use sim_core::clock::game_secs;
use sim_core::fixture::load_world_state_from_fixture_files;
use sim_core::grid::footprint;
use sim_core::pathfind::astar;
use sim_core::LayoutItemKind;

#[test]
fn office_shell_map_structure() {
    let ws = load_world_state_from_fixture_files().unwrap();
    assert_eq!((ws.map.width, ws.map.height), (48, 32));
    // Outer ring fully blocked except exactly the 2-tile door at the
    // bottom edge center.
    for x in 0..48 {
        assert!(ws.map.is_blocked(x, 0), "top ring wall at x={x}");
        let is_door = x == 23 || x == 24;
        assert_eq!(
            !ws.map.is_blocked(x, 31),
            is_door,
            "bottom ring at x={x}: door only at 23/24"
        );
    }
    for y in 0..32 {
        assert!(ws.map.is_blocked(0, y), "left ring wall at y={y}");
        assert!(ws.map.is_blocked(47, y), "right ring wall at y={y}");
    }
    assert_eq!(ws.map.door_tiles, vec![(23, 31), (24, 31)]);
    // Interior carries no wall tiles (walls layer is ring-only; furniture
    // blocking comes from layout_items, not the tmj).
    for y in 1..31 {
        for x in 1..47 {
            assert!(!ws.map.is_blocked(x, y), "interior wall at ({x},{y})?");
        }
    }
}

/// Flood-fill from the main door over the combined collision grid (walls +
/// non-walkable furniture): every chair and every zone's key interaction
/// targets must be reachable (T1.1 acceptance: 大門到所有 zone flood-fill
/// 連通).
#[test]
fn door_reaches_every_zone_and_every_chair() {
    let ws = load_world_state_from_fixture_files().unwrap();
    let (w, h) = (ws.grid.width, ws.grid.height);
    let mut reached = vec![false; (w * h) as usize];
    let mut queue = std::collections::VecDeque::new();
    for &(x, y) in &ws.map.door_tiles {
        if !ws.grid.is_blocked(x, y) {
            reached[(y * w + x) as usize] = true;
            queue.push_back((x, y));
        }
    }
    while let Some((x, y)) = queue.pop_front() {
        for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let i = (ny * w + nx) as usize;
            if reached[i] || ws.grid.is_blocked(nx, ny) {
                continue;
            }
            reached[i] = true;
            queue.push_back((nx, ny));
        }
    }
    let is_reached = |x: i32, y: i32| reached[(y * w + x) as usize];

    // 1. Every chair tile (42 of them) is directly reachable.
    let mut chair_count = 0;
    for item in &ws.layout {
        if item.kind == LayoutItemKind::Chair {
            chair_count += 1;
            assert!(
                is_reached(item.pos_x, item.pos_y),
                "chair {} at ({},{}) unreachable from door",
                item.key,
                item.pos_x,
                item.pos_y
            );
        }
    }
    assert_eq!(chair_count, 42);

    // 2. Interaction targets get >=1 reachable orthogonally-adjacent tile.
    let needs_adjacency = [
        LayoutItemKind::MeetingTable,
        LayoutItemKind::PantryCounter,
        LayoutItemKind::Printer,
        LayoutItemKind::Cabinet,
        LayoutItemKind::Whiteboard,
    ];
    for item in &ws.layout {
        if !needs_adjacency.contains(&item.kind) {
            continue;
        }
        let (fx, fy, fw, fh) = footprint(item);
        let mut ok = false;
        for x in fx..fx + fw {
            if (fy > 0 && is_reached(x, fy - 1)) || (fy + fh < h && is_reached(x, fy + fh)) {
                ok = true;
            }
        }
        for y in fy..fy + fh {
            if (fx > 0 && is_reached(fx - 1, y)) || (fx + fw < w && is_reached(fx + fw, y)) {
                ok = true;
            }
        }
        assert!(
            ok,
            "{} ({:?}) has no reachable adjacent tile",
            item.key, item.kind
        );
    }

    // 3. Every zone has at least one reached representative tile.
    for zone in ["exec", "open_a", "open_b", "meeting", "pantry", "common"] {
        let ok = ws.layout.iter().any(|item| {
            item.zone == zone && {
                let (fx, fy, fw, fh) = footprint(item);
                // walkable item reached directly, or any adjacent reached
                (item.walkable && is_reached(item.pos_x, item.pos_y))
                    || (fx..fx + fw).any(|x| {
                        (fy > 0 && is_reached(x, fy - 1)) || (fy + fh < h && is_reached(x, fy + fh))
                    })
                    || (fy..fy + fh).any(|y| {
                        (fx > 0 && is_reached(fx - 1, y)) || (fx + fw < w && is_reached(fx + fw, y))
                    })
            }
        });
        assert!(ok, "zone '{zone}' has no reachable representative");
    }
}

/// Spec 10.1 "A* golden path": fixed layout (the real office) + fixed
/// endpoints (main door -> 沈書萍's chair, deskA-01-chair at (2,8)) must
/// yield THIS exact path forever. Any engine change that alters it must
/// update this golden expectation visibly in a PR.
#[test]
fn astar_golden_door_to_deska01_chair() {
    let ws = load_world_state_from_fixture_files().unwrap();
    let start = (23, 31); // first door tile
    let goal = (2, 8); // deskA-01-chair (沈書萍's seat)
    let path = astar(&ws.grid, &HashSet::new(), start, goal).expect("path exists");

    // Endpoints and optimality: Manhattan distance is 44 and the straight
    // corridor route is unobstructed, so the optimal length is exactly 44.
    assert_eq!(*path.last().unwrap(), goal);
    assert_eq!(path.len(), 44, "optimal path length (no detours needed)");

    // Shape produced by the deterministic tie-break (f, h, idx): straight
    // north along the central corridor x=23 up to the chair row y=8, then
    // straight west to the chair. Chairs on the way are walkable, so the
    // west leg legitimately crosses the open_a chair row.
    let mut golden: Vec<(i32, i32)> = Vec::new();
    for y in (8..=30).rev() {
        golden.push((23, y)); // north leg x=23, y=30..=8
    }
    for x in (2..=22).rev() {
        golden.push((x, 8)); // west leg y=8, x=22..=2
    }
    assert_eq!(
        path, golden,
        "golden A* path changed — update deliberately via PR"
    );
}

/// Second golden: door -> the VP chair inside the partitioned exec bay.
/// The bay is fenced by partitions left/top/right; its open side is the
/// south (y=5..) plus the free cell (3,4) east of the chair — the
/// deterministic tie-break enters through (3,4). Like the deskA-01
/// golden above, the ENTIRE 48-step path is pinned: any engine change
/// that alters it must update this expectation visibly in a PR.
#[test]
fn astar_golden_door_to_exec_vp_chair() {
    let ws = load_world_state_from_fixture_files().unwrap();
    let path = astar(&ws.grid, &HashSet::new(), (23, 31), (2, 4)).expect("path exists");

    // Shape produced by the deterministic tie-break (f, h, idx): straight
    // north along the central corridor x=23 up to y=5, straight west
    // along y=5 to the bay entry column x=3, one step north into the bay
    // entry cell (3,4), then west onto the chair (2,4). Optimality:
    // manhattan distance (48) equals path length (partitions sit off the
    // tie-broken shortest route, so no detour cost).
    let mut golden: Vec<(i32, i32)> = Vec::new();
    for y in (5..=30).rev() {
        golden.push((23, y)); // north leg x=23, y=30..=5
    }
    for x in (3..=22).rev() {
        golden.push((x, 5)); // west leg y=5, x=22..=3
    }
    golden.push((3, 4)); // north into the bay entry cell
    golden.push((2, 4)); // west onto the VP chair
    assert_eq!(golden.len(), 48, "golden itself must stay 48 steps");
    assert_eq!(
        path, golden,
        "golden A* path changed — update deliberately via PR"
    );
}

#[test]
fn commute_spawn_times_all_before_0930() {
    // Guards the headless test's 09:30 horizon: the latest Appendix A.2
    // spawn (specialist 08:55) plus the longest possible walk comfortably
    // precedes 09:30.
    let ws = load_world_state_from_fixture_files().unwrap();
    for a in &ws.agents {
        assert!(a.spawn_sec >= game_secs(8, 20) && a.spawn_sec <= game_secs(8, 55));
    }
}
