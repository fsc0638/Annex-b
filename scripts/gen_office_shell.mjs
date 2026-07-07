#!/usr/bin/env node
// gen_office_shell.mjs — generates the Phase 1 T1.1 deliverables without
// Tiled GUI:
//
//   assets/tilesets/office_shell_placeholder.png   (self-made CC0 tileset)
//   assets/maps/office_shell.tmj                   (valid Tiled JSON map)
//   web/public/tilesets/office_shell_placeholder.png (copy for the frontend)
//   web/public/maps/office_shell.tmj                 (copy for the frontend)
//
// Map contents per spec 7.2 / T1.1: 48x32 tiles (32px), floor layer, wall
// layer (outer ring + windows on the top edge), one main door on the
// bottom edge center (2 tiles wide, walkable). Wall/window tiles carry a
// custom boolean property `collides=true` on the embedded tileset.
//
// The generator validates BEFORE writing (and exits nonzero without
// writing anything on failure):
//   1. every furniture footprint from scripts/seed_world.sh stays inside
//      the interior (never overlaps the wall ring);
//   2. flood-fill from the door over (walls + non-walkable furniture)
//      reaches every chair tile and at least one orthogonal neighbor of
//      every meeting table / pantry counter / printer / cabinet (spec 7.3
//      validation rule 2 applied to the default layout).
//
// Deterministic output: same inputs -> byte-identical files (idempotency
// is an acceptance criterion). No timestamps, fixed key order, fixed zlib
// level in the PNG encoder.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas } from "./lib/png.mjs";
import {
  REPO_ROOT,
  footprint,
  parseLayoutItems,
} from "./lib/seed_layout.mjs";

export const MAP_W = 48;
export const MAP_H = 32;
export const TILE = 32;

// Door: bottom edge center, 2 tiles wide (spec 7.2 "一扇大門（下緣中央）").
export const DOOR_TILES = [
  { x: 23, y: 31 },
  { x: 24, y: 31 },
];

// Windows: pairs on the top edge (spec 7.2 "窗（上緣）"). Still collides —
// you cannot walk through a window.
const WINDOW_XS = [6, 7, 14, 15, 22, 23, 30, 31, 38, 39];

// Tile ids inside the tileset (gid = firstgid(=1) + id).
const T_FLOOR = 0;
const T_WALL = 1;
const T_WINDOW = 2;
const T_DOOR = 3;
const FIRST_GID = 1;

// ---------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------

function isRing(x, y) {
  return x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
}

function isDoor(x, y) {
  return DOOR_TILES.some((d) => d.x === x && d.y === y);
}

/** Wall-layer tile id for (x,y), or null for empty. */
function wallTile(x, y) {
  if (!isRing(x, y)) return null;
  if (isDoor(x, y)) return null; // walkable opening
  if (y === 0 && WINDOW_XS.includes(x)) return T_WINDOW;
  return T_WALL;
}

function buildLayers() {
  const floor = new Array(MAP_W * MAP_H);
  const walls = new Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      floor[i] = FIRST_GID + (isDoor(x, y) ? T_DOOR : T_FLOOR);
      const w = wallTile(x, y);
      walls[i] = w === null ? 0 : FIRST_GID + w;
    }
  }
  return { floor, walls };
}

// ---------------------------------------------------------------------
// Validation (walls + seed furniture)
// ---------------------------------------------------------------------

function validate(items) {
  const errors = [];

  // 1. Furniture must stay inside the interior (1..46 x 1..30).
  for (const item of items) {
    const fp = footprint(item);
    if (fp.x < 1 || fp.y < 1 || fp.x + fp.w > MAP_W - 1 || fp.y + fp.h > MAP_H - 1) {
      errors.push(
        `furniture ${item.key} footprint (${fp.x},${fp.y} ${fp.w}x${fp.h}) overlaps the wall ring or leaves the map`
      );
    }
  }

  // 2. Flood-fill from the door over walls + non-walkable furniture.
  const blocked = new Uint8Array(MAP_W * MAP_H);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (wallTile(x, y) !== null) blocked[y * MAP_W + x] = 1;
    }
  }
  for (const item of items) {
    if (item.walkable) continue;
    const fp = footprint(item);
    for (let y = fp.y; y < fp.y + fp.h; y++) {
      for (let x = fp.x; x < fp.x + fp.w; x++) {
        blocked[y * MAP_W + x] = 1;
      }
    }
  }

  const reached = new Uint8Array(MAP_W * MAP_H);
  const queue = [];
  for (const d of DOOR_TILES) {
    if (!blocked[d.y * MAP_W + d.x]) {
      reached[d.y * MAP_W + d.x] = 1;
      queue.push([d.x, d.y]);
    }
  }
  while (queue.length > 0) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const i = ny * MAP_W + nx;
      if (blocked[i] || reached[i]) continue;
      reached[i] = 1;
      queue.push([nx, ny]);
    }
  }

  // 2a. Every chair tile must be reached (agents must be able to sit).
  for (const item of items) {
    if (item.kind !== "chair") continue;
    if (!reached[item.pos_y * MAP_W + item.pos_x]) {
      errors.push(`chair ${item.key} at (${item.pos_x},${item.pos_y}) unreachable from door`);
    }
  }

  // 2b. Key interaction targets need >=1 reachable orthogonal neighbor
  //     (spec 7.3 rule 2: meeting 區, pantry, printer, cabinet 可達).
  const mustBeAdjacent = items.filter((it) =>
    ["meeting_table", "pantry_counter", "printer", "cabinet", "whiteboard"].includes(
      it.kind
    )
  );
  for (const item of mustBeAdjacent) {
    const fp = footprint(item);
    let ok = false;
    for (let y = fp.y - 1; y <= fp.y + fp.h && !ok; y++) {
      for (let x = fp.x - 1; x <= fp.x + fp.w && !ok; x++) {
        const inFp =
          x >= fp.x && x < fp.x + fp.w && y >= fp.y && y < fp.y + fp.h;
        if (inFp) continue;
        // Orthogonal neighbors only: same row or same column as footprint.
        const orth =
          (x >= fp.x && x < fp.x + fp.w) || (y >= fp.y && y < fp.y + fp.h);
        if (!orth) continue;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        if (reached[y * MAP_W + x]) ok = true;
      }
    }
    if (!ok) {
      errors.push(`${item.kind} ${item.key} has no reachable adjacent tile`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------
// Tileset PNG (4 tiles, 128x32): floor / wall / window / door
// ---------------------------------------------------------------------

function drawTileset() {
  const c = new Canvas(TILE * 4, TILE);

  // Tile 0: floor — warm light grey with a subtle 1px grid line top/left.
  c.fillRect(0, 0, TILE, TILE, [0xde, 0xd7, 0xc8]);
  c.fillRect(0, 0, TILE, 1, [0xcf, 0xc7, 0xb5]);
  c.fillRect(0, 0, 1, TILE, [0xcf, 0xc7, 0xb5]);

  // Tile 1: wall — dark slate with top highlight and bottom shadow.
  c.fillRect(TILE, 0, TILE, TILE, [0x56, 0x5e, 0x6e]);
  c.fillRect(TILE, 0, TILE, 3, [0x6a, 0x72, 0x84]);
  c.fillRect(TILE, TILE - 3, TILE, 3, [0x46, 0x4d, 0x5a]);

  // Tile 2: window — wall frame with light blue glass and a sill.
  c.fillRect(TILE * 2, 0, TILE, TILE, [0x56, 0x5e, 0x6e]);
  c.fillRect(TILE * 2 + 4, 4, TILE - 8, TILE - 12, [0xa8, 0xcb, 0xe8]);
  c.fillRect(TILE * 2 + 6, 6, 6, 6, [0xc8, 0xe0, 0xf4]); // glint
  c.fillRect(TILE * 2 + 3, TILE - 7, TILE - 6, 3, [0x6a, 0x72, 0x84]); // sill

  // Tile 3: door — floor base with wooden threshold strip.
  c.fillRect(TILE * 3, 0, TILE, TILE, [0xde, 0xd7, 0xc8]);
  c.fillRect(TILE * 3, 10, TILE, 12, [0xb0, 0x8d, 0x57]);
  c.fillRect(TILE * 3, 10, TILE, 2, [0x8f, 0x70, 0x42]);
  c.fillRect(TILE * 3, 20, TILE, 2, [0x8f, 0x70, 0x42]);

  return c.toPng();
}

// ---------------------------------------------------------------------
// Tiled JSON (.tmj) with embedded tileset
// ---------------------------------------------------------------------

function buildTmj(layers) {
  return {
    compressionlevel: -1,
    height: MAP_H,
    infinite: false,
    layers: [
      {
        data: layers.floor,
        height: MAP_H,
        id: 1,
        name: "floor",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: MAP_W,
        x: 0,
        y: 0,
      },
      {
        data: layers.walls,
        height: MAP_H,
        id: 2,
        name: "walls",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: MAP_W,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 3,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.10.2",
    tileheight: TILE,
    tilesets: [
      {
        columns: 4,
        firstgid: FIRST_GID,
        image: "../tilesets/office_shell_placeholder.png",
        imageheight: TILE,
        imagewidth: TILE * 4,
        margin: 0,
        name: "office_shell_placeholder",
        spacing: 0,
        tilecount: 4,
        tileheight: TILE,
        tilewidth: TILE,
        tiles: [
          {
            id: T_WALL,
            properties: [{ name: "collides", type: "bool", value: true }],
          },
          {
            id: T_WINDOW,
            properties: [{ name: "collides", type: "bool", value: true }],
          },
        ],
      },
    ],
    tilewidth: TILE,
    type: "map",
    version: "1.10",
    width: MAP_W,
  };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

function main() {
  const items = parseLayoutItems();
  const errors = validate(items);
  if (errors.length > 0) {
    console.error("gen_office_shell: validation FAILED, nothing written:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const layers = buildLayers();
  const tmj = JSON.stringify(buildTmj(layers), null, 2) + "\n";
  const png = drawTileset();

  const targets = [
    { dir: join(REPO_ROOT, "assets") },
    { dir: join(REPO_ROOT, "web", "public") },
  ];
  for (const t of targets) {
    mkdirSync(join(t.dir, "maps"), { recursive: true });
    mkdirSync(join(t.dir, "tilesets"), { recursive: true });
    writeFileSync(join(t.dir, "maps", "office_shell.tmj"), tmj);
    writeFileSync(
      join(t.dir, "tilesets", "office_shell_placeholder.png"),
      png
    );
  }

  console.log(
    `gen_office_shell: OK — ${MAP_W}x${MAP_H} map, door at ${DOOR_TILES.map(
      (d) => `(${d.x},${d.y})`
    ).join(" ")}, ${WINDOW_XS.length} window tiles, validation passed ` +
      `(${items.length} furniture items checked). Wrote assets/ and web/public/.`
  );
}

main();
