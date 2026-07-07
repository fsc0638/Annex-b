//! Collision grid (Phase 1 T1.2): tmj walls ⊕ non-walkable layout
//! footprints. Rebuildable from parts — Phase 3's layout editor will call
//! [`CollisionGrid::from_map_and_layout`] again after a layout save.

use crate::tilemap::TileMap;
use crate::LayoutItem;

/// Effective footprint (x, y, w, h) of a layout item on the tile grid.
/// rotation 90/270 swaps w and h; pos stays the top-left anchor (same rule
/// as the frontend renderer and the asset generators).
pub fn footprint(item: &LayoutItem) -> (i32, i32, i32, i32) {
    if item.rotation == 90 || item.rotation == 270 {
        (item.pos_x, item.pos_y, item.h, item.w)
    } else {
        (item.pos_x, item.pos_y, item.w, item.h)
    }
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
}
