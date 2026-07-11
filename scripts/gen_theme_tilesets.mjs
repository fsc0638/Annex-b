#!/usr/bin/env node
// gen_theme_tilesets.mjs — generates the 3 non-default background theme
// tilesets (ADR-002 D4: "佔位 tileset 擴為 4 個主題（default／warm／cool／
// dark），由 png.mjs 程式生成（CC0 自製）"). The "default" tileset itself
// is still owned by scripts/gen_office_shell.mjs (byte-identical
// requirement); this script only adds the 3 new theme PNGs plus the
// themes.json catalog the web editor's theme picker fetches.
//
// Same 4-tile semantics as the default tileset (floor/wall/window/door at
// tile ids 0/1/2/3 — see web/src/lib/office_shell_core.mjs's
// TILE_FLOOR/TILE_WALL/TILE_WINDOW/TILE_DOOR), each theme just recolors
// them. Deterministic: fixed RGB literals below, same PNG encoder
// (scripts/lib/png.mjs) as gen_office_shell.mjs, no timestamps.
//
// Writes:
//   assets/tilesets/office_shell_theme_<id>.png       (x3, CC0 self-made)
//   web/public/tilesets/office_shell_theme_<id>.png   (x3, copy)
//   web/public/tilesets/themes.json                   ([{id,label,file}, ...])

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas } from "./lib/png.mjs";
import { REPO_ROOT } from "./lib/seed_layout.mjs";
import { THEME_IDS, TILE, tilesetImageForTheme } from "../web/src/lib/office_shell_core.mjs";

// theme id -> 繁中 label (shown in the web "世界設定" theme picker) +
// the 4-tile color palette (floor / wall / wallHighlight / wallShadow /
// windowFrame / glass / glint / sill / doorBase / doorStrip / doorEdge).
const THEME_LABELS = {
  default: "預設",
  warm: "暖色調",
  cool: "冷色調",
  dark: "深色",
};

const PALETTES = {
  warm: {
    floor: [0xe8, 0xd2, 0xad],
    floorEdge: [0xd9, 0xbc, 0x8d],
    wall: [0x8a, 0x4a, 0x2e],
    wallHi: [0xa8, 0x63, 0x42],
    wallLo: [0x6c, 0x37, 0x20],
    glassFrame: [0x8a, 0x4a, 0x2e],
    glass: [0xf4, 0xd9, 0x9a],
    glint: [0xff, 0xef, 0xc2],
    sill: [0xa8, 0x63, 0x42],
    doorBase: [0xe8, 0xd2, 0xad],
    doorStrip: [0xc4, 0x6a, 0x2f],
    doorEdge: [0x9c, 0x51, 0x22],
  },
  cool: {
    floor: [0xd6, 0xe2, 0xea],
    floorEdge: [0xbd, 0xd0, 0xdc],
    wall: [0x3d, 0x5a, 0x73],
    wallHi: [0x53, 0x76, 0x92],
    wallLo: [0x2c, 0x42, 0x56],
    glassFrame: [0x3d, 0x5a, 0x73],
    glass: [0xc7, 0xe6, 0xf7],
    glint: [0xe6, 0xf6, 0xff],
    sill: [0x53, 0x76, 0x92],
    doorBase: [0xd6, 0xe2, 0xea],
    doorStrip: [0x6f, 0x8f, 0xa6],
    doorEdge: [0x51, 0x6c, 0x80],
  },
  dark: {
    floor: [0x2b, 0x2c, 0x31],
    floorEdge: [0x1f, 0x20, 0x24],
    wall: [0x16, 0x17, 0x1a],
    wallHi: [0x28, 0x2a, 0x2f],
    wallLo: [0x0a, 0x0a, 0x0c],
    glassFrame: [0x16, 0x17, 0x1a],
    glass: [0x3a, 0x4a, 0x5c],
    glint: [0x5a, 0x74, 0x8c],
    sill: [0x28, 0x2a, 0x2f],
    doorBase: [0x2b, 0x2c, 0x31],
    doorStrip: [0x4a, 0x3a, 0x28],
    doorEdge: [0x30, 0x24, 0x18],
  },
};

function drawThemeTileset(theme) {
  const p = PALETTES[theme];
  if (!p) throw new Error(`gen_theme_tilesets: no palette for theme "${theme}"`);
  const c = new Canvas(TILE * 4, TILE);

  // Tile 0: floor
  c.fillRect(0, 0, TILE, TILE, p.floor);
  c.fillRect(0, 0, TILE, 1, p.floorEdge);
  c.fillRect(0, 0, 1, TILE, p.floorEdge);

  // Tile 1: wall
  c.fillRect(TILE, 0, TILE, TILE, p.wall);
  c.fillRect(TILE, 0, TILE, 3, p.wallHi);
  c.fillRect(TILE, TILE - 3, TILE, 3, p.wallLo);

  // Tile 2: window
  c.fillRect(TILE * 2, 0, TILE, TILE, p.glassFrame);
  c.fillRect(TILE * 2 + 4, 4, TILE - 8, TILE - 12, p.glass);
  c.fillRect(TILE * 2 + 6, 6, 6, 6, p.glint);
  c.fillRect(TILE * 2 + 3, TILE - 7, TILE - 6, 3, p.sill);

  // Tile 3: door
  c.fillRect(TILE * 3, 0, TILE, TILE, p.doorBase);
  c.fillRect(TILE * 3, 10, TILE, 12, p.doorStrip);
  c.fillRect(TILE * 3, 10, TILE, 2, p.doorEdge);
  c.fillRect(TILE * 3, 20, TILE, 2, p.doorEdge);

  return c.toPng();
}

function main() {
  const nonDefaultThemes = THEME_IDS.filter((id) => id !== "default");
  const targets = [join(REPO_ROOT, "assets", "tilesets"), join(REPO_ROOT, "web", "public", "tilesets")];

  for (const theme of nonDefaultThemes) {
    const filename = tilesetImageForTheme(theme);
    const png = drawThemeTileset(theme);
    for (const dir of targets) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), png);
    }
  }

  const themes = THEME_IDS.map((id) => ({
    id,
    label: THEME_LABELS[id],
    file: `/tilesets/${tilesetImageForTheme(id)}`,
  }));
  const themesJsonDir = join(REPO_ROOT, "web", "public", "tilesets");
  mkdirSync(themesJsonDir, { recursive: true });
  writeFileSync(join(themesJsonDir, "themes.json"), `${JSON.stringify(themes, null, 2)}\n`);

  console.log(
    `gen_theme_tilesets: OK — wrote ${nonDefaultThemes.length} theme tileset PNG(s) ` +
      `(${nonDefaultThemes.join(", ")}) to assets/tilesets/ and web/public/tilesets/, ` +
      `plus web/public/tilesets/themes.json (${themes.length} themes).`
  );
}

main();
