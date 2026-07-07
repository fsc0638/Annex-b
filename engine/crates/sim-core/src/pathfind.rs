//! Deterministic 4-directional A* (Phase 1 T1.2, spec 10.1 "A* golden
//! path").
//!
//! Determinism contract (relied on by the golden tests and, later, by the
//! S6 golden-replay criterion):
//! - Manhattan heuristic, unit step cost, 4 neighbors expanded in the
//!   fixed order N, E, S, W (up, right, down, left).
//! - Open-set ordering: min-heap keyed by `(f, h, cell_index)` — ties on
//!   `f` prefer the node closer to the goal (smaller `h`), then the
//!   smaller row-major cell index. No RNG, no hash-iteration order
//!   anywhere on the hot path.
//! - A neighbor's parent is updated only on a strictly smaller `g`.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use crate::grid::CollisionGrid;

const NEIGHBORS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

fn manhattan(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}

/// Finds the shortest path from `start` to `goal` over `grid`, treating
/// `extra_blocked` cells (e.g. other agents' current positions) as
/// obstacles too. Returns the path EXCLUDING `start`, INCLUDING `goal`;
/// `Some(vec![])` when `start == goal`; `None` when unreachable or the
/// goal itself is blocked. `extra_blocked` never makes `start` invalid
/// (the agent is standing there).
pub fn astar(
    grid: &CollisionGrid,
    extra_blocked: &HashSet<(i32, i32)>,
    start: (i32, i32),
    goal: (i32, i32),
) -> Option<Vec<(i32, i32)>> {
    if start == goal {
        return Some(vec![]);
    }
    if grid.is_blocked(goal.0, goal.1) || extra_blocked.contains(&goal) {
        return None;
    }
    if grid.is_blocked(start.0, start.1) {
        return None;
    }

    let w = grid.width;
    let h = grid.height;
    let idx = |p: (i32, i32)| (p.1 * w + p.0) as usize;

    let mut g_cost: Vec<i32> = vec![i32::MAX; (w * h) as usize];
    let mut parent: Vec<usize> = vec![usize::MAX; (w * h) as usize];
    let mut closed: Vec<bool> = vec![false; (w * h) as usize];

    // Min-heap entries: Reverse((f, h, cell_index)).
    let mut open: BinaryHeap<Reverse<(i32, i32, usize)>> = BinaryHeap::new();
    g_cost[idx(start)] = 0;
    open.push(Reverse((
        manhattan(start, goal),
        manhattan(start, goal),
        idx(start),
    )));

    while let Some(Reverse((_f, _h, ci))) = open.pop() {
        if closed[ci] {
            continue; // stale heap entry
        }
        closed[ci] = true;
        let cur = ((ci as i32) % w, (ci as i32) / w);
        if cur == goal {
            let mut path = Vec::new();
            let mut walk = ci;
            while walk != idx(start) {
                path.push(((walk as i32) % w, (walk as i32) / w));
                walk = parent[walk];
            }
            path.reverse();
            return Some(path);
        }
        for (dx, dy) in NEIGHBORS {
            let np = (cur.0 + dx, cur.1 + dy);
            if grid.is_blocked(np.0, np.1) || extra_blocked.contains(&np) {
                continue;
            }
            let ni = idx(np);
            if closed[ni] {
                continue;
            }
            let ng = g_cost[ci] + 1;
            if ng < g_cost[ni] {
                g_cost[ni] = ng;
                parent[ni] = ci;
                let nh = manhattan(np, goal);
                open.push(Reverse((ng + nh, nh, ni)));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilemap::TileMap;
    use serde_json::json;

    /// Builds an open-interior map with a wall ring and one door on the
    /// bottom edge at x = w/2.
    fn grid_with_walls(w: usize, h: usize, extra_walls: &[(i32, i32)]) -> CollisionGrid {
        let mut walls = vec![0i64; w * h];
        for y in 0..h {
            for x in 0..w {
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    walls[y * w + x] = 2;
                }
            }
        }
        walls[(h - 1) * w + w / 2] = 0;
        for &(x, y) in extra_walls {
            walls[y as usize * w + x as usize] = 2;
        }
        let tmj = json!({
            "width": w, "height": h,
            "layers": [{"type": "tilelayer", "name": "walls", "data": walls}],
            "tilesets": [{"firstgid": 1, "tiles": [
                {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
            ]}]
        })
        .to_string();
        let map = TileMap::from_tmj_str(&tmj).unwrap();
        CollisionGrid::from_map_and_layout(&map, &[])
    }

    #[test]
    fn start_equals_goal_is_empty_path() {
        let grid = grid_with_walls(6, 6, &[]);
        assert_eq!(astar(&grid, &HashSet::new(), (2, 2), (2, 2)), Some(vec![]));
    }

    #[test]
    fn golden_straight_line_east() {
        let grid = grid_with_walls(8, 6, &[]);
        let path = astar(&grid, &HashSet::new(), (1, 2), (5, 2)).unwrap();
        assert_eq!(path, vec![(2, 2), (3, 2), (4, 2), (5, 2)]);
    }

    #[test]
    fn golden_l_shape_prefers_goalward_tie_break() {
        // From (1,1) to (3,3) in an open room: f-ties are broken by
        // smaller h then smaller row-major index. With N,E,S,W expansion
        // and the (f, h, idx) key this settles on a staircase path that
        // must never change without a PR-visible golden update.
        let grid = grid_with_walls(8, 8, &[]);
        let path = astar(&grid, &HashSet::new(), (1, 1), (3, 3)).unwrap();
        assert_eq!(path, vec![(2, 1), (3, 1), (3, 2), (3, 3)]);
    }

    #[test]
    fn golden_detour_around_wall() {
        // Vertical wall segment at x=4, y=1..=4 forces a detour below.
        let grid = grid_with_walls(9, 7, &[(4, 1), (4, 2), (4, 3), (4, 4)]);
        let path = astar(&grid, &HashSet::new(), (2, 2), (6, 2)).unwrap();
        assert_eq!(
            path,
            vec![
                (3, 2),
                (3, 3),
                (3, 4),
                (3, 5),
                (4, 5),
                (5, 5),
                (5, 4),
                (5, 3),
                (5, 2),
                (6, 2)
            ]
        );
        assert_eq!(
            path.len(),
            10,
            "detour length must equal manhattan+detour cost"
        );
    }

    #[test]
    fn unreachable_goal_returns_none() {
        // Box the goal in completely.
        let grid = grid_with_walls(9, 9, &[(5, 4), (7, 4), (6, 3), (6, 5)]);
        assert_eq!(astar(&grid, &HashSet::new(), (1, 1), (6, 4)), None);
    }

    #[test]
    fn blocked_goal_returns_none() {
        let grid = grid_with_walls(6, 6, &[(3, 3)]);
        assert_eq!(astar(&grid, &HashSet::new(), (1, 1), (3, 3)), None);
    }

    #[test]
    fn extra_blocked_forces_detour_and_none_on_goal() {
        let grid = grid_with_walls(8, 6, &[]);
        let mut extra = HashSet::new();
        extra.insert((3, 2));
        let path = astar(&grid, &extra, (1, 2), (5, 2)).unwrap();
        assert!(
            !path.contains(&(3, 2)),
            "path must avoid extra-blocked cell"
        );
        assert_eq!(*path.last().unwrap(), (5, 2));
        assert_eq!(
            path.len(),
            6,
            "one-cell sidestep costs exactly 2 extra moves"
        );

        extra.insert((5, 2));
        assert_eq!(astar(&grid, &extra, (1, 2), (5, 2)), None);
    }

    #[test]
    fn deterministic_across_runs() {
        let grid = grid_with_walls(12, 10, &[(5, 3), (5, 4), (5, 5), (6, 5)]);
        let a = astar(&grid, &HashSet::new(), (2, 7), (9, 2)).unwrap();
        for _ in 0..50 {
            let b = astar(&grid, &HashSet::new(), (2, 7), (9, 2)).unwrap();
            assert_eq!(a, b, "same input must always give the identical path");
        }
    }

    #[test]
    fn path_length_is_optimal_manhattan_when_clear() {
        let grid = grid_with_walls(10, 10, &[]);
        let path = astar(&grid, &HashSet::new(), (1, 1), (8, 7)).unwrap();
        assert_eq!(path.len() as i32, manhattan((1, 1), (8, 7)));
    }
}
