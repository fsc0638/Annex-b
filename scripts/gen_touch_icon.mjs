#!/usr/bin/env node

// gen_touch_icon.mjs — 產生 web/public/apple-touch-icon.png（含 -precomposed
// 同內容副本），消除瀏覽器自動探測的 404。
//
// 180×180、12×12 邏輯格 ×15 放大：暖色調迷你辦公室（牆環＋門開口＋辦公桌
// ＋座椅＋盆栽），呼應遊戲畫面的像素風格。自製 CC0，登記於
// assets/CREDITS.md。輸出決定性（無時間戳/亂數；重跑 byte-identical）。
// 非 seed 衍生資產，故不掛進 ci.sh 產生器決定性層（一次性靜態素材）。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./lib/png.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const publicDir = path.join(repoRoot, "web", "public");

const GRID = 12;
const SCALE = 15; // 12 * 15 = 180px（apple-touch-icon 標準尺寸）
const SIZE = GRID * SCALE;

// 暖色調主題同系配色（office_shell_theme_warm 家族）
const WALL = [122, 82, 48, 255]; // 牆：暖棕
const FLOOR = [230, 220, 195, 255]; // 地板：米色
const DESK = [139, 94, 52, 255]; // 辦公桌：深棕
const CHAIR = [185, 196, 208, 255]; // 座椅：淺藍灰
const PLANT = [63, 125, 78, 255]; // 盆栽：綠
const DOOR = [200, 178, 140, 255]; // 門開口：地板略深

// 12×12 佈局：W=牆 F=地板 D=桌 C=椅 P=植 O=門
const LAYOUT = [
  "WWWWWWWWWWWW",
  "WPFFFFFFFFPW",
  "WFFFFFFFFFFW",
  "WFDDFFFFDDFW",
  "WFCCFFFFCCFW",
  "WFFFFFFFFFFW",
  "WFDDFFFFDDFW",
  "WFCCFFFFCCFW",
  "WFFFFFFFFFFW",
  "WPFFFFFFFFPW",
  "WFFFFFFFFFFW",
  "WWWWWOOWWWWW",
];

const COLOR_OF = { W: WALL, F: FLOOR, D: DESK, C: CHAIR, P: PLANT, O: DOOR };

const rgba = new Uint8Array(SIZE * SIZE * 4);
for (let gy = 0; gy < GRID; gy++) {
  for (let gx = 0; gx < GRID; gx++) {
    const color = COLOR_OF[LAYOUT[gy][gx]];
    for (let py = 0; py < SCALE; py++) {
      for (let px = 0; px < SCALE; px++) {
        const i = ((gy * SCALE + py) * SIZE + gx * SCALE + px) * 4;
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = color[3];
      }
    }
  }
}

const png = encodePng(SIZE, SIZE, rgba);
for (const name of ["apple-touch-icon.png", "apple-touch-icon-precomposed.png"]) {
  writeFileSync(path.join(publicDir, name), png);
  console.log(`[touch-icon] wrote ${path.join(publicDir, name)} (${png.length} bytes)`);
}
