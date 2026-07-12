#!/usr/bin/env node
// check_character_frames.mjs — structural self-check for
// web/src/lib/character_frames.ts (ADR-003 D3 milestone A2).
//
// Imports the .ts module directly by its relative path with an explicit
// `.ts` extension. This works with no build step because Node's built-in
// TypeScript support (stable since Node 23.6, and what `node --version`
// reports as available in this environment) strips erasable type syntax at
// load time; character_frames.ts deliberately only uses erasable
// constructs (interfaces, type aliases, `as const`) so it loads directly
// here exactly as it will when bundled into the Next.js app.
//
// This is a STRUCTURAL check only (frames land inside the 1792x1280 sheet,
// every direction has exactly 3 frames) — it cannot verify the frames show
// the correct pose/orientation. See the TODO block at the top of
// character_frames.ts for what remains commander-unverified.

import {
  CHAR_FRAME,
  SHEET_COLS,
  SHEET_ROWS,
  WALK_DIRS,
  walkFrameRects,
} from "../web/src/lib/character_frames.ts";

const SHEET_W = SHEET_COLS * 32; // 1792
const SHEET_H = SHEET_ROWS * 32; // 1280

let failures = 0;

function check(label, cond) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    failures++;
  }
}

check(
  `CHAR_FRAME is 32x64 (got ${CHAR_FRAME.w}x${CHAR_FRAME.h})`,
  CHAR_FRAME.w === 32 && CHAR_FRAME.h === 64
);
check(
  `sheet is 1792x1280 (SHEET_COLS=${SHEET_COLS} SHEET_ROWS=${SHEET_ROWS} -> ${SHEET_W}x${SHEET_H})`,
  SHEET_W === 1792 && SHEET_H === 1280
);
check(`4 walk directions declared (got ${WALK_DIRS.length})`, WALK_DIRS.length === 4);

for (const dir of WALK_DIRS) {
  const frames = walkFrameRects(dir);
  check(`${dir}: exactly 3 frames (got ${frames.length})`, frames.length === 3);
  frames.forEach((f, i) => {
    const withinX = f.sx >= 0 && f.sx + f.w <= SHEET_W;
    const withinY = f.sy >= 0 && f.sy + f.h <= SHEET_H;
    check(
      `${dir}[${i}]: rect (sx=${f.sx}, sy=${f.sy}, w=${f.w}, h=${f.h}) within ${SHEET_W}x${SHEET_H}`,
      withinX && withinY
    );
    check(`${dir}[${i}]: frame size is 32x64 (got ${f.w}x${f.h})`, f.w === 32 && f.h === 64);
  });
}

// down/left/up must resolve to distinct sheet rows (never accidentally
// aliased); right is expected to alias left's row (flipped), not distinct.
{
  const rows = new Map(
    WALK_DIRS.filter((d) => d !== "right").map((d) => [d, walkFrameRects(d)[0].sy])
  );
  const distinctRows = new Set(rows.values());
  check(
    `down/left/up use 3 distinct sheet rows (got sy=${[...rows.entries()]
      .map(([d, sy]) => `${d}:${sy}`)
      .join(", ")})`,
    distinctRows.size === 3
  );
  const leftSy = walkFrameRects("left")[0].sy;
  const rightSy = walkFrameRects("right")[0].sy;
  const rightFlips = walkFrameRects("right").every((f) => f.flipX);
  check(
    `right reuses left's row (sy=${rightSy} vs left sy=${leftSy}) and is flipX`,
    rightSy === leftSy && rightFlips
  );
}

console.log("");
if (failures === 0) {
  console.log("check_character_frames: OK — all checks passed");
  process.exit(0);
} else {
  console.error(`check_character_frames: ${failures} check(s) FAILED`);
  process.exit(1);
}
