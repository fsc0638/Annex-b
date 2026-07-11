//! Collision grid (Phase 1 T1.2): tmj walls ⊕ non-walkable layout
//! footprints. Rebuildable from parts — Phase 3's layout editor will call
//! [`CollisionGrid::from_map_and_layout`] again after a layout save.

use crate::tilemap::TileMap;
use crate::LayoutItem;

/// Effective footprint (x, y, w, h) of a layout item on the tile grid.
/// rotation 90/270 swaps w and h; pos stays the top-left anchor (same rule
/// as the frontend renderer and the asset generators). `rotation` is
/// normalized via `rem_euclid(360)` before the 90/270 comparison, so
/// out-of-range or negative values (e.g. 450 or -90, both equivalent to
/// 90) are handled the same as their canonical form — the web-side
/// `footprintOf` in web/src/game/types.ts normalizes identically so the
/// two can never disagree about a footprint.
pub fn footprint(item: &LayoutItem) -> (i32, i32, i32, i32) {
    let rotation = item.rotation.rem_euclid(360);
    if rotation == 90 || rotation == 270 {
        (item.pos_x, item.pos_y, item.h, item.w)
    } else {
        (item.pos_x, item.pos_y, item.w, item.h)
    }
}

/// Validates that every layout item's footprint lies fully within the
/// map's bounds and does not overlap a tile the map itself marks as
/// colliding (ADR-002 D2, `PUT /api/v1/world/map` and `PUT
/// /api/v1/world/layout`: "現有 layout items 全部在界內且不壓牆"). Does
/// NOT check layout-vs-layout overlap (that is a design choice left to the
/// editor UI, unchanged from before this validation existed).
pub fn validate_layout_within_map(map: &TileMap, layout: &[LayoutItem]) -> Result<(), String> {
    for item in layout {
        let (fx, fy, fw, fh) = footprint(item);
        for y in fy..fy + fh {
            for x in fx..fx + fw {
                if x < 0 || y < 0 || x >= map.width || y >= map.height {
                    return Err(format!(
                        "layout item '{}' ({}) footprint cell ({x},{y}) is outside map bounds \
                         {}x{}",
                        item.key, item.name, map.width, map.height
                    ));
                }
                if map.is_blocked(x, y) {
                    return Err(format!(
                        "layout item '{}' ({}) footprint cell ({x},{y}) overlaps a wall/window \
                         tile",
                        item.key, item.name
                    ));
                }
            }
        }
    }
    Ok(())
}

/// A rough "minimum viable size" hint for a 422 error message when a
/// smaller map can no longer fit the existing furniture (ADR-002 D2: "訊息
/// 含最小可行尺寸"): the bounding box of every layout item's footprint,
/// plus one tile on the far edge for the boundary wall ring (items already
/// assume a wall ring on the near edge, since the seed layout's minimum
/// coordinate is 1, not 0).
pub fn suggested_min_size(layout: &[LayoutItem]) -> (i32, i32) {
    let mut max_x = 0;
    let mut max_y = 0;
    for item in layout {
        let (fx, fy, fw, fh) = footprint(item);
        max_x = max_x.max(fx + fw);
        max_y = max_y.max(fy + fh);
    }
    (max_x + 1, max_y + 1)
}

#[derive(Debug, Clone)]
pub struct CollisionGrid {
    pub width: i32,
    pub height: i32,
    blocked: Vec<bool>,
}

impl CollisionGrid {
    pub fn from_map_and_layout(map: &TileMap, layout: &[LayoutItem]) -> Self {
        let mut blocked = vec![false; (map.width * map.height) as usize];
        for y in 0..map.height {
            for x in 0..map.width {
                if map.is_blocked(x, y) {
                    blocked[(y * map.width + x) as usize] = true;
                }
            }
        }
        for item in layout {
            if item.walkable {
                continue;
            }
            let (fx, fy, fw, fh) = footprint(item);
            for y in fy..fy + fh {
                for x in fx..fx + fw {
                    if x >= 0 && y >= 0 && x < map.width && y < map.height {
                        blocked[(y * map.width + x) as usize] = true;
                    }
                }
            }
        }
        CollisionGrid {
            width: map.width,
            height: map.height,
            blocked,
        }
    }

    /// Out-of-bounds counts as blocked.
    pub fn is_blocked(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return true;
        }
        self.blocked[(y * self.width + x) as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn open_map(w: usize, h: usize) -> TileMap {
        // Walls only on the ring except one door at bottom center.
        let mut walls = vec![0i64; w * h];
        for y in 0..h {
            for x in 0..w {
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    walls[y * w + x] = 2;
                }
            }
        }
        walls[(h - 1) * w + w / 2] = 0;
        let tmj = json!({
            "width": w, "height": h,
            "layers": [{"type": "tilelayer", "name": "walls", "data": walls}],
            "tilesets": [{"firstgid": 1, "tiles": [
                {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
            ]}]
        })
        .to_string();
        TileMap::from_tmj_str(&tmj).unwrap()
    }

    fn item(
        kind: crate::LayoutItemKind,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        rotation: i32,
        walkable: bool,
    ) -> LayoutItem {
        LayoutItem {
            id: Uuid::nil(),
            world_id: Uuid::nil(),
            kind,
            key: "t".into(),
            name: "t".into(),
            pos_x: x,
            pos_y: y,
            w,
            h,
            rotation,
            zone: "common".into(),
            walkable,
            affords: vec![],
            meta: serde_json::Value::Null,
        }
    }

    #[test]
    fn non_walkable_footprint_blocks_and_chair_does_not() {
        let map = open_map(8, 8);
        let layout = vec![
            item(crate::LayoutItemKind::Desk, 2, 2, 2, 1, 0, false),
            item(crate::LayoutItemKind::Chair, 2, 3, 1, 1, 0, true),
        ];
        let grid = CollisionGrid::from_map_and_layout(&map, &layout);
        assert!(grid.is_blocked(2, 2));
        assert!(grid.is_blocked(3, 2));
        assert!(!grid.is_blocked(2, 3), "walkable chair must not block");
        assert!(!grid.is_blocked(4, 2));
    }

    #[test]
    fn rotation_90_swaps_footprint_dimensions() {
        let map = open_map(8, 8);
        // 1x3 partition rotated 90 degrees occupies 3x1.
        let layout = vec![item(
            crate::LayoutItemKind::Partition,
            2,
            2,
            1,
            3,
            90,
            false,
        )];
        let grid = CollisionGrid::from_map_and_layout(&map, &layout);
        assert!(grid.is_blocked(2, 2));
        assert!(grid.is_blocked(3, 2));
        assert!(grid.is_blocked(4, 2));
        assert!(!grid.is_blocked(2, 3), "unrotated cell must stay free");
        assert!(!grid.is_blocked(2, 4));
    }

    #[test]
    fn rotation_450_and_negative_90_normalize_like_90() {
        // rem_euclid(360): 450 -> 90, -90 -> 270. Both are the "swap w/h"
        // family, so a 1x3 partition at either rotation occupies 3x1 —
        // identical footprint to the canonical 90 case above.
        let map = open_map(8, 8);
        for rotation in [450, -90] {
            let layout = vec![item(
                crate::LayoutItemKind::Partition,
                2,
                2,
                1,
                3,
                rotation,
                false,
            )];
            let grid = CollisionGrid::from_map_and_layout(&map, &layout);
            assert!(grid.is_blocked(2, 2), "rotation={rotation}");
            assert!(grid.is_blocked(3, 2), "rotation={rotation}");
            assert!(grid.is_blocked(4, 2), "rotation={rotation}");
            assert!(
                !grid.is_blocked(2, 3),
                "rotation={rotation}: unrotated cell must stay free"
            );
            assert!(!grid.is_blocked(2, 4), "rotation={rotation}");
        }
    }

    #[test]
    fn rotation_180_keeps_footprint_dimensions() {
        let map = open_map(8, 8);
        let layout = vec![item(
            crate::LayoutItemKind::Partition,
            2,
            2,
            1,
            3,
            180,
            false,
        )];
        let grid = CollisionGrid::from_map_and_layout(&map, &layout);
        assert!(grid.is_blocked(2, 2));
        assert!(grid.is_blocked(2, 3));
        assert!(grid.is_blocked(2, 4));
        assert!(!grid.is_blocked(3, 2));
    }

    #[test]
    fn ring_walls_carry_over_from_map() {
        let map = open_map(8, 8);
        let grid = CollisionGrid::from_map_and_layout(&map, &[]);
        assert!(grid.is_blocked(0, 0));
        assert!(grid.is_blocked(7, 7));
        assert!(!grid.is_blocked(4, 7), "door tile stays walkable");
        assert!(grid.is_blocked(-1, 4));
        assert!(grid.is_blocked(8, 4));
    }

    #[test]
    fn validate_layout_within_map_accepts_in_bounds_off_wall_items() {
        let map = open_map(8, 8);
        let layout = vec![item(crate::LayoutItemKind::Desk, 2, 2, 2, 1, 0, false)];
        assert!(validate_layout_within_map(&map, &layout).is_ok());
    }

    #[test]
    fn validate_layout_within_map_rejects_out_of_bounds_item() {
        let map = open_map(8, 8);
        let layout = vec![item(crate::LayoutItemKind::Desk, 8, 2, 2, 1, 0, false)];
        let err = validate_layout_within_map(&map, &layout).unwrap_err();
        assert!(err.contains("outside map bounds"), "{err}");
    }

    #[test]
    fn validate_layout_within_map_rejects_item_on_wall() {
        let map = open_map(8, 8);
        let layout = vec![item(crate::LayoutItemKind::Desk, 0, 2, 1, 1, 0, false)];
        let err = validate_layout_within_map(&map, &layout).unwrap_err();
        assert!(err.contains("overlaps a wall"), "{err}");
    }

    #[test]
    fn suggested_min_size_is_bounding_box_plus_one() {
        let layout = vec![
            item(crate::LayoutItemKind::Desk, 2, 2, 2, 1, 0, false),
            item(crate::LayoutItemKind::Chair, 5, 6, 1, 1, 0, true),
        ];
        // Bounding box: x in [2,6), y in [2,7) -> max_x=6, max_y=7 -> +1 each.
        assert_eq!(suggested_min_size(&layout), (7, 8));
    }
}
