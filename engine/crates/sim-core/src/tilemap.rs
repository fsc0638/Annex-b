//! Tiled `.tmj` shell-map parsing (Phase 1 T1.2).
//!
//! The engine only needs three things from the map: dimensions, which tiles
//! collide (the `walls` tile layer, whose tileset tiles carry a custom
//! boolean property `collides=true`), and where the door is. The door is
//! *derived*, not annotated: door tiles are the walkable gaps in the
//! boundary ring (spec 7.2 — one main door on the bottom edge; the office
//! shell has no other ring opening).

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct TileMap {
    pub width: i32,
    pub height: i32,
    blocked: Vec<bool>,
    /// Walkable boundary-ring cells (the main door), sorted by (y, x) for
    /// determinism. Used as spawn tiles for commuting agents.
    pub door_tiles: Vec<(i32, i32)>,
}

impl TileMap {
    /// Parses a Tiled JSON map string. Requirements (all violations are
    /// loud errors, not silent defaults): orthogonal map, a tile layer
    /// named `walls`, at least one tileset with `collides` tile
    /// properties, layer data length == width*height.
    pub fn from_tmj_str(s: &str) -> Result<Self, String> {
        let root: Value = serde_json::from_str(s).map_err(|e| format!("tmj: invalid JSON: {e}"))?;

        let width = get_i64(&root, "width")? as i32;
        let height = get_i64(&root, "height")? as i32;
        if width <= 0 || height <= 0 {
            return Err(format!("tmj: bad dimensions {width}x{height}"));
        }

        // Collect gids whose tile carries collides=true. gid = firstgid + id.
        let mut collides_gids: Vec<i64> = Vec::new();
        let tilesets = root
            .get("tilesets")
            .and_then(|v| v.as_array())
            .ok_or("tmj: missing tilesets")?;
        for ts in tilesets {
            let firstgid = get_i64(ts, "firstgid")?;
            let Some(tiles) = ts.get("tiles").and_then(|v| v.as_array()) else {
                continue;
            };
            for tile in tiles {
                let id = get_i64(tile, "id")?;
                let Some(props) = tile.get("properties").and_then(|v| v.as_array()) else {
                    continue;
                };
                let collides = props.iter().any(|p| {
                    p.get("name").and_then(|n| n.as_str()) == Some("collides")
                        && p.get("value").and_then(|v| v.as_bool()) == Some(true)
                });
                if collides {
                    collides_gids.push(firstgid + id);
                }
            }
        }
        if collides_gids.is_empty() {
            return Err("tmj: no tile with collides=true found in any tileset".into());
        }

        let layers = root
            .get("layers")
            .and_then(|v| v.as_array())
            .ok_or("tmj: missing layers")?;
        let walls = layers
            .iter()
            .find(|l| {
                l.get("type").and_then(|v| v.as_str()) == Some("tilelayer")
                    && l.get("name").and_then(|v| v.as_str()) == Some("walls")
            })
            .ok_or("tmj: no tilelayer named 'walls'")?;
        let data = walls
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or("tmj: walls layer has no data array")?;
        if data.len() != (width * height) as usize {
            return Err(format!(
                "tmj: walls data length {} != {}x{}",
                data.len(),
                width,
                height
            ));
        }

        let mut blocked = vec![false; (width * height) as usize];
        for (i, gid_v) in data.iter().enumerate() {
            let gid = gid_v
                .as_i64()
                .ok_or_else(|| format!("tmj: non-integer gid at index {i}"))?;
            if gid != 0 && collides_gids.contains(&gid) {
                blocked[i] = true;
            }
        }

        let mut door_tiles = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let on_ring = x == 0 || y == 0 || x == width - 1 || y == height - 1;
                if on_ring && !blocked[(y * width + x) as usize] {
                    door_tiles.push((x, y));
                }
            }
        }
        // Row-major scan above already yields (y, x) order; keep explicit
        // sort as a determinism guarantee independent of scan order.
        door_tiles.sort_by_key(|&(x, y)| (y, x));

        Ok(TileMap {
            width,
            height,
            blocked,
            door_tiles,
        })
    }

    /// Out-of-bounds counts as blocked.
    pub fn is_blocked(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return true;
        }
        self.blocked[(y * self.width + x) as usize]
    }
}

fn get_i64(v: &Value, key: &str) -> Result<i64, String> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| format!("tmj: missing/invalid integer field '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_tmj() -> String {
        // 4x3 map: ring of walls (gid 2, collides) with a door gap at
        // (2,2) on the bottom edge; floor gid 1 (no collides).
        let w = 4;
        let h = 3;
        let mut walls = vec![0i64; w * h];
        for y in 0..h {
            for x in 0..w {
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    walls[y * w + x] = 2;
                }
            }
        }
        walls[2 * w + 2] = 0; // door
        serde_json::json!({
            "width": w, "height": h,
            "layers": [
                {"type": "tilelayer", "name": "floor", "data": vec![1i64; w*h]},
                {"type": "tilelayer", "name": "walls", "data": walls},
            ],
            "tilesets": [{
                "firstgid": 1,
                "tiles": [
                    {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
                ]
            }]
        })
        .to_string()
    }

    #[test]
    fn parses_walls_and_derives_door() {
        let map = TileMap::from_tmj_str(&tiny_tmj()).unwrap();
        assert_eq!((map.width, map.height), (4, 3));
        assert!(map.is_blocked(0, 0));
        assert!(map.is_blocked(3, 2));
        assert!(!map.is_blocked(1, 1));
        assert_eq!(map.door_tiles, vec![(2, 2)]);
    }

    #[test]
    fn oob_is_blocked() {
        let map = TileMap::from_tmj_str(&tiny_tmj()).unwrap();
        assert!(map.is_blocked(-1, 0));
        assert!(map.is_blocked(0, 3));
        assert!(map.is_blocked(4, 0));
    }

    #[test]
    fn rejects_map_without_walls_layer() {
        let bad = serde_json::json!({
            "width": 2, "height": 2,
            "layers": [{"type": "tilelayer", "name": "floor", "data": [1,1,1,1]}],
            "tilesets": [{"firstgid": 1, "tiles": [
                {"id": 1, "properties": [{"name": "collides", "type": "bool", "value": true}]}
            ]}]
        })
        .to_string();
        assert!(TileMap::from_tmj_str(&bad).is_err());
    }

    #[test]
    fn rejects_map_without_collides_property() {
        let bad = serde_json::json!({
            "width": 2, "height": 2,
            "layers": [{"type": "tilelayer", "name": "walls", "data": [2,2,2,2]}],
            "tilesets": [{"firstgid": 1, "tiles": []}]
        })
        .to_string();
        assert!(TileMap::from_tmj_str(&bad).is_err());
    }
}
