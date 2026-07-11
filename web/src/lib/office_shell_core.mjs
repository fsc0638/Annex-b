// office_shell_core.mjs — pure office-shell tilemap generation core.
//
// ADR-002 D1: "單一產生器、客戶端產圖、引擎收圖驗證". This module is the
// SINGLE place map geometry is computed. It is imported by both:
//   - scripts/gen_office_shell.mjs (Node CLI — writes files to disk), and
//   - the browser (web "世界設定" panel — produces a TMJ object in-memory
//     to PUT to /api/v1/world/map).
//
// Hard constraint: zero Node API surface. No `node:fs`, `node:path`,
// `node:process`, no globals that only exist under Node (no `Buffer`,
// no `__dirname`). Every input is a plain argument; every output is a
// plain JS value (a TMJ-shaped object, or a thrown Error). This is what
// lets the exact same code run in a browser bundle.
//
// generateOfficeShell({width, height, theme, layoutItems}) -> TMJ object
//   Throws (does not return) on any validation failure; every thrown
//   Error's `.message` names the concrete reason (bad size, bad theme,
//   unreachable interior tile(s), or a specific furniture item and why).
//
// Deterministic: no timestamps, no Math.random, no Date, no key-order
// nondeterminism (plain object literals — V8/all engines preserve
// insertion order for string keys) — same input always produces a
// byte-identical TMJ object once JSON.stringify'd with a fixed indent.

export const TILE = 32;
export const DEFAULT_WIDTH = 48;
export const DEFAULT_HEIGHT = 32;
export const MIN_SIZE = 20;
export const MAX_SIZE = 96;

// The 4 embedded-tileset tile ids (gid = FIRST_GID + id), shared by every
// theme — a theme only ever swaps the tileset PNG filename, never the
// tile semantics (floor/wall/window/door stay tile 0/1/2/3 in every
// theme's PNG, see scripts/gen_theme_tilesets.mjs).
export const TILE_FLOOR = 0;
export const TILE_WALL = 1;
export const TILE_WINDOW = 2;
export const TILE_DOOR = 3;
const FIRST_GID = 1;

// Registered theme ids. "default" is the only one whose tileset image
// keeps the legacy filename (office_shell_placeholder.png) — this is
// what makes the *default-parameter* output byte-identical to the
// pre-D1 generator's output (ADR-002 D1 hard requirement). Every other
// theme's image is `office_shell_theme_<id>.png`.
export const THEME_IDS = ["default", "warm", "cool", "dark"];

/**
 * Tileset image filename for a theme id. Throws on an unregistered theme.
 * @param {string} theme
 * @returns {string}
 */
export function tilesetImageForTheme(theme) {
  if (!THEME_IDS.includes(theme)) {
    throw new Error(
      `office_shell_core: unknown theme "${theme}" (expected one of: ${THEME_IDS.join(", ")})`
    );
  }
  return theme === "default"
    ? "office_shell_placeholder.png"
    : `office_shell_theme_${theme}.png`;
}

/**
 * Door tiles: 2-wide opening centered on the bottom edge. For width=48
 * this reproduces the original hardcoded (23,31)/(24,31).
 * @param {number} width
 * @param {number} height
 * @returns {Array<{x:number,y:number}>}
 */
export function doorTiles(width, height) {
  const x0 = Math.floor(width / 2) - 1;
  return [
    { x: x0, y: height - 1 },
    { x: x0 + 1, y: height - 1 },
  ];
}

/**
 * Window x-coordinates on the top edge: pairs of 2, spaced 8 tiles apart,
 * starting at x=6, staying clear of the corner posts. For width=48 this
 * reproduces the original hardcoded [6,7,14,15,22,23,30,31,38,39].
 * @param {number} width
 * @returns {number[]}
 */
export function windowXs(width) {
  const xs = [];
  let x = 6;
  while (x + 1 <= width - 2) {
    xs.push(x, x + 1);
    x += 8;
  }
  return xs;
}

function isRing(x, y, width, height) {
  return x === 0 || y === 0 || x === width - 1 || y === height - 1;
}

function isDoorTile(x, y, doors) {
  return doors.some((d) => d.x === x && d.y === y);
}

function wallTileId(x, y, width, height, doors, winXs) {
  if (!isRing(x, y, width, height)) return null;
  if (isDoorTile(x, y, doors)) return null; // walkable opening
  if (y === 0 && winXs.includes(x)) return TILE_WINDOW;
  return TILE_WALL;
}

function buildLayers(width, height, doors, winXs) {
  const floor = new Array(width * height);
  const walls = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      floor[i] = FIRST_GID + (isDoorTile(x, y, doors) ? TILE_DOOR : TILE_FLOOR);
      const w = wallTileId(x, y, width, height, doors, winXs);
      walls[i] = w === null ? 0 : FIRST_GID + w;
    }
  }
  return { floor, walls };
}

/**
 * BFS flood-fill from the door tiles over non-zero `walls` cells.
 * @returns {Uint8Array} length width*height, 1 where reached from a door.
 */
function floodFillFromDoor(width, height, walls, doors) {
  const blocked = new Uint8Array(width * height);
  for (let i = 0; i < walls.length; i++) {
    if (walls[i] !== 0) blocked[i] = 1;
  }
  const reached = new Uint8Array(width * height);
  const queue = [];
  for (const d of doors) {
    const i = d.y * width + d.x;
    if (!blocked[i]) {
      reached[i] = 1;
      queue.push([d.x, d.y]);
    }
  }
  let head = 0;
  const deltas = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  while (head < queue.length) {
    const [x, y] = queue[head++];
    for (const [dx, dy] of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const i = ny * width + nx;
      if (blocked[i] || reached[i]) continue;
      reached[i] = 1;
      queue.push([nx, ny]);
    }
  }
  return reached;
}

/**
 * Effective footprint of a layout item on the tile grid, accounting for
 * rotation (90/270 swap w and h — same rule sim-core and the web editor
 * use). Deliberately duplicated (not imported) from
 * scripts/lib/seed_layout.mjs's `footprint()`: that module's top-level
 * `readFileSync` import would violate this module's zero-Node-API
 * constraint even though `footprint()` itself doesn't touch the
 * filesystem.
 * @param {{pos_x:number,pos_y:number,w:number,h:number,rotation:number}} item
 */
function footprintOf(item) {
  const swap = item.rotation === 90 || item.rotation === 270;
  return {
    x: item.pos_x,
    y: item.pos_y,
    w: swap ? item.h : item.w,
    h: swap ? item.w : item.h,
  };
}

const ADJACENCY_REQUIRED_KINDS = new Set([
  "meeting_table",
  "pantry_counter",
  "printer",
  "cabinet",
  "whiteboard",
]);

/**
 * Optional furniture-aware validation, mirroring the pre-D1 generator's
 * `validate()`: every item's footprint must stay inside the interior
 * (never overlap the wall ring), every chair must be reachable from the
 * door, and every meeting_table/pantry_counter/printer/cabinet/whiteboard
 * needs at least one reachable orthogonal neighbor tile. Only called when
 * the caller supplies a non-empty `layoutItems` — arbitrary custom room
 * sizes (e.g. the web "世界設定" resize flow before furniture has been
 * re-laid-out) skip this and rely solely on the structural flood-fill
 * check below.
 * @param {Array<object>} items
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} walls
 * @param {Array<{x:number,y:number}>} doors
 * @returns {string[]} error messages (empty = valid)
 */
function validateLayoutItems(items, width, height, walls, doors) {
  const errors = [];

  for (const item of items) {
    const fp = footprintOf(item);
    if (fp.x < 1 || fp.y < 1 || fp.x + fp.w > width - 1 || fp.y + fp.h > height - 1) {
      errors.push(
        `furniture ${item.key ?? "?"} footprint (${fp.x},${fp.y} ${fp.w}x${fp.h}) overlaps the wall ring or leaves the ${width}x${height} map`
      );
    }
  }

  const blocked = new Uint8Array(width * height);
  for (let i = 0; i < walls.length; i++) {
    if (walls[i] !== 0) blocked[i] = 1;
  }
  for (const item of items) {
    if (item.walkable) continue;
    const fp = footprintOf(item);
    for (let y = fp.y; y < fp.y + fp.h; y++) {
      for (let x = fp.x; x < fp.x + fp.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        blocked[y * width + x] = 1;
      }
    }
  }
  const reached = new Uint8Array(width * height);
  const queue = [];
  for (const d of doors) {
    const i = d.y * width + d.x;
    if (!blocked[i]) {
      reached[i] = 1;
      queue.push([d.x, d.y]);
    }
  }
  let head = 0;
  const deltas = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  while (head < queue.length) {
    const [x, y] = queue[head++];
    for (const [dx, dy] of deltas) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const i = ny * width + nx;
      if (blocked[i] || reached[i]) continue;
      reached[i] = 1;
      queue.push([nx, ny]);
    }
  }

  for (const item of items) {
    if (item.kind !== "chair") continue;
    if (!reached[item.pos_y * width + item.pos_x]) {
      errors.push(`chair ${item.key ?? "?"} at (${item.pos_x},${item.pos_y}) unreachable from door`);
    }
  }

  for (const item of items) {
    if (!ADJACENCY_REQUIRED_KINDS.has(item.kind)) continue;
    const fp = footprintOf(item);
    let ok = false;
    for (let y = fp.y - 1; y <= fp.y + fp.h && !ok; y++) {
      for (let x = fp.x - 1; x <= fp.x + fp.w && !ok; x++) {
        const inFp = x >= fp.x && x < fp.x + fp.w && y >= fp.y && y < fp.y + fp.h;
        if (inFp) continue;
        const orth = (x >= fp.x && x < fp.x + fp.w) || (y >= fp.y && y < fp.y + fp.h);
        if (!orth) continue;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (reached[y * width + x]) ok = true;
      }
    }
    if (!ok) {
      errors.push(`${item.kind} ${item.key ?? "?"} has no reachable adjacent tile`);
    }
  }

  return errors;
}

function buildTmj(width, height, layers, image) {
  return {
    compressionlevel: -1,
    height,
    infinite: false,
    layers: [
      {
        data: layers.floor,
        height,
        id: 1,
        name: "floor",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width,
        x: 0,
        y: 0,
      },
      {
        data: layers.walls,
        height,
        id: 2,
        name: "walls",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width,
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
        image: `../tilesets/${image}`,
        imageheight: TILE,
        imagewidth: TILE * 4,
        margin: 0,
        name: image.replace(/\.png$/, ""),
        spacing: 0,
        tilecount: 4,
        tileheight: TILE,
        tilewidth: TILE,
        tiles: [
          {
            id: TILE_WALL,
            properties: [{ name: "collides", type: "bool", value: true }],
          },
          {
            id: TILE_WINDOW,
            properties: [{ name: "collides", type: "bool", value: true }],
          },
        ],
      },
    ],
    tilewidth: TILE,
    type: "map",
    version: "1.10",
    width,
  };
}

/**
 * Generates a Tiled JSON (.tmj) map object for the office shell.
 *
 * @param {object} [opts]
 * @param {number} [opts.width=48] tile columns, must be an integer in
 *   [MIN_SIZE, MAX_SIZE] (20..96 — same range D2's engine-side
 *   `PUT /world/map` validator enforces).
 * @param {number} [opts.height=32] tile rows, same range as width.
 * @param {string} [opts.theme="default"] one of THEME_IDS.
 * @param {Array<object>} [opts.layoutItems=[]] optional furniture rows
 *   (shape: {kind,key,pos_x,pos_y,w,h,rotation,walkable}) to additionally
 *   validate against the generated shell (bounds + reachability). Pass
 *   the parsed seed layout when generating the canonical 48x32 map; leave
 *   empty for arbitrary custom-size shells with no known furniture yet.
 * @returns {object} a TMJ-shaped plain object, ready for
 *   `JSON.stringify(tmj, null, 2) + "\n"`.
 * @throws {Error} on invalid width/height, an unregistered theme, any
 *   interior tile unreachable from the door (structural flood-fill
 *   failure), or (when `layoutItems` is non-empty) any furniture item
 *   out of bounds / unreachable — the error message names the concrete
 *   reason(s).
 */
export function generateOfficeShell(opts = {}) {
  const {
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    theme = "default",
    layoutItems = [],
  } = opts;

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(
      `generateOfficeShell: width/height must be integers, got ${width}x${height}`
    );
  }
  if (width < MIN_SIZE || width > MAX_SIZE) {
    throw new Error(
      `generateOfficeShell: width must be within ${MIN_SIZE}..${MAX_SIZE}, got ${width}`
    );
  }
  if (height < MIN_SIZE || height > MAX_SIZE) {
    throw new Error(
      `generateOfficeShell: height must be within ${MIN_SIZE}..${MAX_SIZE}, got ${height}`
    );
  }

  const image = tilesetImageForTheme(theme); // throws on unknown theme

  const doors = doorTiles(width, height);
  const winXs = windowXs(width);
  const layers = buildLayers(width, height, doors, winXs);

  // Structural flood-fill: every non-wall tile must be reachable from the
  // door. For an empty box this is trivially true; the check exists so
  // future wall-layout changes (interior partitions, etc.) fail loudly
  // instead of silently producing an unreachable pocket.
  const reached = floodFillFromDoor(width, height, layers.walls, doors);
  const unreachable = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (layers.walls[i] === 0 && !reached[i]) unreachable.push(`(${x},${y})`);
    }
  }
  if (unreachable.length > 0) {
    const shown = unreachable.slice(0, 10).join(", ");
    const more = unreachable.length > 10 ? `, +${unreachable.length - 10} more` : "";
    throw new Error(
      `generateOfficeShell: ${unreachable.length} interior tile(s) unreachable from the door: ${shown}${more}`
    );
  }

  if (layoutItems.length > 0) {
    const errors = validateLayoutItems(layoutItems, width, height, layers.walls, doors);
    if (errors.length > 0) {
      throw new Error(`generateOfficeShell: furniture validation FAILED:\n  - ${errors.join("\n  - ")}`);
    }
  }

  return buildTmj(width, height, layers, image);
}
