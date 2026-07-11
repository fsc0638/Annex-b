#!/usr/bin/env node
// gen_office_shell.mjs — thin CLI shell around
// web/src/lib/office_shell_core.mjs (ADR-002 D1: "單一產生器，禁止第二份
// 產圖邏輯"). All map geometry / validation lives in the core module;
// this file only handles CLI args, the (default-theme-only) tileset PNG,
// and writing files to disk.
//
// Usage:
//   node scripts/gen_office_shell.mjs [--width N] [--height N]
//     [--theme default|warm|cool|dark] [--out path/to/file.tmj]
//
// Defaults (--width 48 --height 32 --theme default, no --out): writes the
// CANONICAL office shell to both
//   assets/maps/office_shell.tmj + assets/tilesets/office_shell_placeholder.png
//   web/public/maps/office_shell.tmj + web/public/tilesets/office_shell_placeholder.png
// This default-parameter output MUST stay byte-identical to the
// pre-D1 generator's output — ci.sh's determinism layer enforces this via
// `git diff --exit-code`.
//
// When --out is given, only the TMJ JSON is written to that single path
// (no tileset PNG, no canonical assets/ or web/public/ writes) — this is
// the mode used to smoke-test non-default sizes/themes without touching
// the committed canonical files (see scripts/ci.sh's generator layer).
//
// Furniture-aware validation (bounds + reachability against the real
// seed layout, scripts/lib/seed_layout.mjs) only runs when width/height
// match the canonical 48x32 default — the 94 seeded furniture items are
// laid out for that exact grid and are meaningless at other sizes.
// Non-default sizes still get office_shell_core's structural flood-fill
// check (every interior tile reachable from the door).
//
// Theme tileset PNGs (warm/cool/dark) are generated separately by
// scripts/gen_theme_tilesets.mjs — this script only draws/writes the
// legacy "default" placeholder PNG.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas } from "./lib/png.mjs";
import { REPO_ROOT, parseLayoutItems } from "./lib/seed_layout.mjs";
import {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  TILE,
  generateOfficeShell,
} from "../web/src/lib/office_shell_core.mjs";

// ---------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    theme: "default",
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--width") args.width = Number(argv[++i]);
    else if (a === "--height") args.height = Number(argv[++i]);
    else if (a === "--theme") args.theme = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`gen_office_shell: unknown argument "${a}"`);
  }
  return args;
}

// ---------------------------------------------------------------------
// Default-theme tileset PNG (4 tiles, 128x32): floor / wall / window / door
// (unchanged from the pre-D1 generator — kept here, not in the core
// module, because it needs the Node-only PNG encoder).
// ---------------------------------------------------------------------

function drawDefaultTileset() {
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
// Main
// ---------------------------------------------------------------------

function main() {
  const { width, height, theme, out } = parseArgs(process.argv.slice(2));

  const isCanonicalSize = width === DEFAULT_WIDTH && height === DEFAULT_HEIGHT;
  // The 94 seeded furniture items are laid out for the exact 48x32
  // canonical grid; only pass them into the validator at that size.
  const layoutItems = isCanonicalSize ? parseLayoutItems() : [];

  let tmjObj;
  try {
    tmjObj = generateOfficeShell({ width, height, theme, layoutItems });
  } catch (err) {
    console.error(`gen_office_shell: validation FAILED, nothing written:\n  ${err.message}`);
    process.exit(1);
  }

  const tmj = JSON.stringify(tmjObj, null, 2) + "\n";

  if (out) {
    writeFileSync(out, tmj);
    console.log(`gen_office_shell: OK — wrote ${width}x${height} (theme=${theme}) map to ${out}`);
    return;
  }

  const targets = [join(REPO_ROOT, "assets"), join(REPO_ROOT, "web", "public")];
  for (const dir of targets) {
    mkdirSync(join(dir, "maps"), { recursive: true });
    writeFileSync(join(dir, "maps", "office_shell.tmj"), tmj);
  }

  if (theme === "default") {
    const png = drawDefaultTileset();
    for (const dir of targets) {
      mkdirSync(join(dir, "tilesets"), { recursive: true });
      writeFileSync(join(dir, "tilesets", "office_shell_placeholder.png"), png);
    }
  }

  console.log(
    `gen_office_shell: OK — ${width}x${height} map (theme=${theme}), ` +
      `${isCanonicalSize ? `${layoutItems.length} furniture items checked` : "no furniture check (non-canonical size)"}. ` +
      `Wrote assets/ and web/public/.`
  );
}

main();
