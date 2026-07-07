#!/usr/bin/env node
// gen_agent_sprites.mjs — generates the 9 agent walking spritesheets
// (Phase 1 T1.4) as self-made CC0 placeholder pixel art. No downloads,
// no dependencies (node 20 stdlib PNG encoder in lib/png.mjs).
//
// Sheet layout per agent (96x128 PNG, 32x32 frames):
//   rows    = facing direction: 0=down, 1=left, 2=right, 3=up
//   columns = walk frames: 0=left-step, 1=stand, 2=right-step
// The frontend animates columns 0->1->2->1 while moving and rests on
// column 1 when idle/seated.
//
// sprite_key list is parsed from scripts/seed_world.sh (single source of
// truth), so a renamed/added agent shows up here automatically. Each
// agent gets a distinct shirt color (grade-flavored, all fictional).
//
// Output: assets/sprites/agents/<sprite_key>.png (+ web/public copy).
// Registered in assets/CREDITS.md as self-generated CC0.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas } from "./lib/png.mjs";
import { REPO_ROOT, parseAgents } from "./lib/seed_layout.mjs";

const FRAME = 32;
const COLS = 3;
const ROWS = 4;

// Distinct shirt colors keyed by sprite_key (fallback: slate). Chosen for
// mutual contrast on the light floor.
const SHIRT_COLORS = {
  agent_fangyining: [0x2c, 0x3e, 0x6b], // VP: navy suit
  agent_gaozixuan: [0x54, 0x5d, 0x68], // manager: charcoal
  agent_shenshuping: [0x6b, 0x3f, 0x87], // senior: purple
  agent_guolihang: [0x2e, 0x7d, 0x32], // ramp/baggage: green
  agent_zengruotong: [0xc6, 0x62, 0x1a], // cargo/mail: orange
  agent_hanzhiyuan: [0x0e, 0x7c, 0x86], // pax/lounge: teal
  agent_liaoyian: [0xa8, 0x32, 0x3a], // GSE: red
  agent_jiangbinglun: [0x7a, 0x5c, 0x2e], // quotation: brown
  agent_ruanxiaoqing: [0x4a, 0x90, 0xd9], // temp staff: light blue
};

const SKIN = [0xe8, 0xc3, 0x9e];
const HAIR = [0x2b, 0x22, 0x1c];
const PANTS = [0x33, 0x3a, 0x45];
const SHOES = [0x1f, 0x23, 0x2a];
const EYE = [0x10, 0x10, 0x14];

function darken(c, f) {
  return [Math.floor(c[0] * f), Math.floor(c[1] * f), Math.floor(c[2] * f)];
}

/**
 * Draws one 32x32 frame at (ox, oy).
 * dir: 0=down 1=left 2=right 3=up; step: -1 left-step, 0 stand, 1 right-step.
 */
function drawFrame(c, ox, oy, shirt, dir, step) {
  const cx = ox + 16; // horizontal center

  // Legs/pants (y 22..27) + shoes (y 27..29). Steps offset the two legs
  // vertically a bit to suggest a stride.
  const legL = step === -1 ? 1 : 0; // forward lift for left leg
  const legR = step === 1 ? 1 : 0;
  c.fillRect(cx - 4, oy + 22 - legL, 3, 5 + legL, PANTS);
  c.fillRect(cx + 1, oy + 22 - legR, 3, 5 + legR, PANTS);
  c.fillRect(cx - 4, oy + 27 - legL, 3, 2, SHOES);
  c.fillRect(cx + 1, oy + 27 - legR, 3, 2, SHOES);

  // Torso/shirt (y 13..22), slight profile shift for side views.
  const bodyShift = dir === 1 ? -1 : dir === 2 ? 1 : 0;
  c.fillRect(cx - 5 + bodyShift, oy + 13, 10, 9, shirt);
  // Arms: swing opposite to legs when stepping.
  const armL = step === -1 ? 1 : step === 1 ? -1 : 0;
  const armR = -armL;
  const sleeve = darken(shirt, 0.8);
  if (dir !== 2) c.fillRect(cx - 7 + bodyShift, oy + 14 + armL, 2, 7, sleeve);
  if (dir !== 1) c.fillRect(cx + 5 + bodyShift, oy + 14 + armR, 2, 7, sleeve);

  // Head (y 4..13): skin block + hair cap; face features by direction.
  const headShift = dir === 1 ? -1 : dir === 2 ? 1 : 0;
  c.fillRect(cx - 4 + headShift, oy + 5, 8, 8, SKIN);
  c.fillRect(cx - 4 + headShift, oy + 3, 8, 3, HAIR);
  if (dir === 3) {
    // Back view: hair covers the whole head.
    c.fillRect(cx - 4 + headShift, oy + 5, 8, 6, HAIR);
  } else if (dir === 0) {
    c.set(cx - 2 + headShift, oy + 8, EYE);
    c.set(cx + 1 + headShift, oy + 8, EYE);
  } else if (dir === 1) {
    c.set(cx - 3 + headShift, oy + 8, EYE);
    c.fillRect(cx + 1 + headShift, oy + 3, 3, 8, HAIR); // hair to the back
  } else {
    c.set(cx + 2 + headShift, oy + 8, EYE);
    c.fillRect(cx - 4 + headShift, oy + 3, 3, 8, HAIR);
  }
}

function drawSheet(shirt) {
  const c = new Canvas(FRAME * COLS, FRAME * ROWS);
  const steps = [-1, 0, 1];
  for (let dir = 0; dir < ROWS; dir++) {
    for (let col = 0; col < COLS; col++) {
      drawFrame(c, col * FRAME, dir * FRAME, shirt, dir, steps[col]);
    }
  }
  return c.toPng();
}

function main() {
  const agents = parseAgents();
  const targets = [
    join(REPO_ROOT, "assets", "sprites", "agents"),
    join(REPO_ROOT, "web", "public", "sprites", "agents"),
  ];
  for (const dir of targets) mkdirSync(dir, { recursive: true });

  for (const agent of agents) {
    const shirt = SHIRT_COLORS[agent.sprite_key] ?? [0x60, 0x67, 0x70];
    const png = drawSheet(shirt);
    for (const dir of targets) {
      writeFileSync(join(dir, `${agent.sprite_key}.png`), png);
    }
  }
  console.log(
    `gen_agent_sprites: OK — ${agents.length} spritesheets (${FRAME * COLS}x${
      FRAME * ROWS
    }, 4 dirs x 3 frames) written to assets/ and web/public/.`
  );
}

main();
