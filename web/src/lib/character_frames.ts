// character_frames.ts — LimeZu "Character Generator 2.0" walk-frame
// coordinate table (ADR-003 D3).
//
// Zero React/DOM/Node API surface (same discipline as office_shell_core.mjs)
// so this module can be imported both by browser code (.tsx compositing a
// walk texture on an offscreen canvas) and by a plain Node script for a
// structural self-check (scripts/check_character_frames.mjs imports this
// file directly by its .ts path — Node's built-in TS type-stripping runs it
// without a build step; see that script's header comment).
//
// Sheet geometry (measured directly off the purchased source PNGs, e.g.
// `assets/tilesets/limezu-modern-office/.../Character Pieces/Bodies/32x32/
// Body_01.png`, and every Eyes/Hairstyles/Outfits/Accessories 32x32 piece —
// they all share this exact canvas): 1792x1280px = 56 columns x 40 rows of
// 32x32 tiles. A character is 32 wide x 64 tall (TWO stacked tile-rows, feet
// in the bottom row) — the doc calls one such "animation row" a (2k, 2k+1)
// sheet-row pair, addressed here by its top row index `row` (= 2k).
//
// ============================================================================
// 驗證狀態（2026-07-12 指揮官裁決）：方向列（down=sr4/left=sr16/up=sr18/
// right=左翻轉）已經雙重目視驗證確認——(a) 指揮官的 _charpoc 逐列合成檢視、
// (b) 實作 agent 的 PIL 合成比對（排除了 sr0/sr2 這兩個無腿部動作的偽候選）。
// 乾淨載入下 9 名角色（含 32x64 客製外觀）渲染位置/朝向皆正確。步幅欄位
// [1,2,4] 為合理裁決值：若日後在真實桌面瀏覽器观察行走動畫覺得步態不順，
// 只需微調下方 WALK_FRAMES 的 cols（單一常數，無其他改動）。
// ----------------------------------------------------------------------------
// 原始挑選方法（保留供日後參考）：walk frame columns were picked by visually
// inspecting composited (body+outfit+hair) crops of the candidate rows with
// PIL (see session scratchpad), NOT from vendor documentation — LimeZu ships
// no animation-row index in this package (only Character Pieces/
// CHARACTER_GENERATOR.txt, which documents layer stacking order, not
// animation rows). Specifically:
//   - DOWN: rows sr0-sr14 (8 row-pairs) are ALL front-facing but are 8
//     DIFFERENT idle-type animations (bow/greet, hands-clasped, a close-up
//     pose, sitting, phone-to-ear, holding-object, ...) — only sr4 showed
//     clear alternating leg movement across its first 6 columns, so that's
//     the pick. sr0/sr2 (an initially-plausible guess) are NOT walk frames
//     (no leg movement at all across their frames) — flagged in case a
//     future asset revision reorders rows.
//   - LEFT (sr16) / UP (sr18): each is a single row-pair whose first ~6
//     columns show a clear walk stride followed by columns that look like a
//     different (possibly back-facing/idle) pose — only the first 6 columns
//     were treated as the walk cycle.
//   - The exact 3-of-6 column subsample per direction (currently columns
//     1/2/4, meant as "left-step / stand / right-step") is a reasonable but
//     unverified guess at which of the 6 frames are the visually-distinct
//     stride vs. passing poses.
// ============================================================================

/** One character frame: 32 wide, 64 tall (two stacked 32x32 tile-rows). */
export const CHAR_FRAME = { w: 32, h: 64 } as const;

/** Sheet columns (1792 / 32). Every Character Pieces 32x32 PNG shares this
 * width, regardless of layer (Bodies/Eyes/Hairstyles/Outfits/Accessories). */
export const SHEET_COLS = 56;

/** Sheet rows, in 32px tile-row units (1280 / 32). An "animation row" (one
 * 32x64 character) spans two of these: (row, row + 1). */
export const SHEET_ROWS = 40;

export type WalkDir = "down" | "left" | "up" | "right";

/** One resolved walk-cycle frame's source rectangle on a 1792x1280 Character
 * Pieces sheet, plus whether the caller must horizontally flip it when
 * drawing (used for "right", which reuses "left"'s pixels mirrored — LimeZu
 * ships no separate right-facing row, matching the existing 96x128 agent
 * sprite contract's DIR_RIGHT convention). */
export interface WalkFrameRect {
  sx: number;
  sy: number;
  w: number;
  h: number;
  flipX: boolean;
}

interface WalkRowSpec {
  /** Top sheet-row index (the "2k" in the (2k, 2k+1) row pair). */
  row: number;
  /** The 3 frame columns to sample, in playback order: [left-step, stand,
   * right-step] per ADR-003 D3 ("走路每方向取 3 幀（左踏/站立/右踏）"). */
  cols: readonly [number, number, number];
  /** True if this direction's pixels must be drawn horizontally mirrored
   * (i.e. this row's art faces the opposite way from `dir`). */
  flipX: boolean;
}

/**
 * Walk-cycle row/column picks per direction. A single easy-to-edit object —
 * change `row`/`cols` here and every consumer (walkFrameRects, the future
 * browser compositor, the self-check script) picks it up with no other
 * change needed. See the TODO block above for how these values were chosen
 * and what remains commander-unverified.
 */
export const WALK_FRAMES: Record<WalkDir, WalkRowSpec> = {
  down: { row: 4, cols: [1, 2, 4], flipX: false },
  left: { row: 16, cols: [1, 2, 4], flipX: false },
  up: { row: 18, cols: [1, 2, 4], flipX: false },
  // LimeZu ships no dedicated right-facing row (confirmed: commander's scan
  // found only sr16=left and sr18=up as the non-down walk rows) — right
  // reuses left's row/columns, flipped horizontally at draw time.
  right: { row: 16, cols: [1, 2, 4], flipX: true },
};

/**
 * Returns the 3 walk-cycle frame rects (source rectangles into a 1792x1280
 * Character Pieces sheet) for `dir`, in playback order
 * [left-step, stand, right-step].
 */
export function walkFrameRects(dir: WalkDir): WalkFrameRect[] {
  const spec = WALK_FRAMES[dir];
  return spec.cols.map((col) => ({
    sx: col * CHAR_FRAME.w,
    sy: spec.row * 32,
    w: CHAR_FRAME.w,
    h: CHAR_FRAME.h,
    flipX: spec.flipX,
  }));
}

/** All four directions, in the same order the existing 96x128 agent sprite
 * contract uses (scripts/gen_agent_sprites.mjs / OfficeCanvas.tsx DIR_*):
 * down, left, right, up. Convenience for callers building a full 4-direction
 * sheet in one pass. */
export const WALK_DIRS: readonly WalkDir[] = ["down", "left", "right", "up"];
