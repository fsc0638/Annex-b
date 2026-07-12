// character_compositor.ts — ADR-003 D3 browser-side character sprite
// compositor: given an agent's `appearance` layer selection and the
// `/character/manifest.json` catalog, draws the selected part PNGs onto an
// offscreen <canvas> walk-cycle sheet (down/left/right/up x 3 frames each,
// 32x64 per frame) using `character_frames.ts`'s walk-frame coordinate
// table as the single source of truth for where each frame lives on a
// purchased Character Pieces sheet.
//
// Zero Pixi/React dependency — OfficeCanvas wraps the returned canvas in a
// `Pixi.Texture.from(canvas)` itself; AgentPanel draws it straight into a
// 2D preview <canvas>. This module only imports character_frames.ts (never
// modifies it, per ADR-003 D3's "commander-verify" walk-frame table).

import { CHAR_FRAME, WALK_DIRS, walkFrameRects, type WalkDir } from "./character_frames";
import {
  CHARACTER_LAYER_ORDER,
  type AppearanceLayers,
  type CharacterLayerKey,
  type CharacterManifest,
} from "@/game/types";

/** Output sheet layout: 3 columns (walk-cycle frames) x 4 rows (one per
 * WALK_DIRS entry, same down/left/right/up order OfficeCanvas's existing
 * DIR_DOWN/DIR_LEFT/DIR_RIGHT/DIR_UP constants use for the placeholder
 * sprite sheet — so a composited sheet slices with the identical
 * row-index-as-direction convention). */
const FRAME_COLS = 3;
export const COMPOSITE_SHEET_W = CHAR_FRAME.w * FRAME_COLS; // 96
export const COMPOSITE_SHEET_H = CHAR_FRAME.h * WALK_DIRS.length; // 256

/** Fills in every layer key with `null` for any absent one, so callers
 * never have to special-case a partial `AppearanceLayers` object (the
 * engine only ever stores whatever subset of keys was last PATCHed — see
 * `AgentRow.appearance`'s doc comment in game/types.ts). */
export function normalizeAppearance(
  appearance: AppearanceLayers | null | undefined
): Record<CharacterLayerKey, string | null> {
  const out = {} as Record<CharacterLayerKey, string | null>;
  for (const layer of CHARACTER_LAYER_ORDER) {
    out[layer] = appearance?.[layer] ?? null;
  }
  return out;
}

/** True if every layer is unset — equivalent to `appearance === null` for
 * rendering purposes (both mean "use the generated placeholder sprite"). */
export function isEmptyAppearance(appearance: AppearanceLayers | null | undefined): boolean {
  if (!appearance) return true;
  return CHARACTER_LAYER_ORDER.every((layer) => (appearance[layer] ?? null) === null);
}

/** Stable cache/dedup key for an appearance selection: layers in the fixed
 * `CHARACTER_LAYER_ORDER`, so two objects with the same picks but
 * different key-insertion order (or missing vs. explicit-null keys)
 * collapse to the same key. Empty selections all key to the literal
 * string `"null"` (never a valid composite — see `isEmptyAppearance`). */
export function appearanceKey(appearance: AppearanceLayers | null | undefined): string {
  if (isEmptyAppearance(appearance)) return "null";
  const normalized = normalizeAppearance(appearance);
  return JSON.stringify(CHARACTER_LAYER_ORDER.map((layer) => normalized[layer]));
}

// ---- Simple LRU helper (insertion-order Map doubles as recency order) ---
//
// F2 fix: both module-level caches below used to grow without bound — every
// distinct piece PNG (imageCache) or layer combo (compositeCache) ever seen
// this session stayed resident forever. Browsing e.g. 200 hairstyles could
// pin ~1.8GB of decoded bitmaps. A `Map` already preserves insertion order,
// so "oldest" == "first key returned by .keys()"; touching a key on a hit
// (delete+re-set) promotes it to most-recently-used without needing a
// separate linked list.

function lruTouch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  lruTouch(cache, key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

// ---- Part-image loading (HTMLImageElement, module-level cache) ----------

// ~16 distinct piece sheets resident at once, comfortably under the ~150MB
// budget the review flagged (each decoded sheet is a few MB at most).
const IMAGE_CACHE_MAX_ENTRIES = 16;
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadPieceImage(src: string): Promise<HTMLImageElement | null> {
  const existing = imageCache.get(src);
  if (existing) {
    lruTouch(imageCache, src, existing); // hit: refresh recency
    return existing;
  }
  const pending = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  lruSet(imageCache, src, pending, IMAGE_CACHE_MAX_ENTRIES);
  return pending;
}

function pieceFile(
  manifest: CharacterManifest,
  layer: CharacterLayerKey,
  pieceId: string
): string | null {
  const entry = manifest.layers[layer]?.find((p) => p.id === pieceId);
  return entry?.file ?? null;
}

// ---- Composite build (module-level cache keyed by appearanceKey) --------

// 32 composited 96x256 sheets resident at once. Eviction here only affects
// re-composition cost (a cache miss re-draws from `imageCache`'d/loaded part
// PNGs) — it must NOT invalidate any Pixi `Texture` already built from a
// canvas this cache previously returned. OfficeCanvas's own
// `characterTextureCache` (game/OfficeCanvas.tsx) calls `Texture.from(canvas)`
// once per key and keeps the resulting `Texture[][]`; Pixi's canvas source
// copies/uploads the canvas's pixels to the GPU at that point and holds its
// own reference to the canvas element for the texture's lifetime — it does
// not look the canvas back up in this module's `compositeCache`. So evicting
// a key here is safe: it only means a *future* `compositeCharacter()` call
// for that key rebuilds the canvas from scratch; textures already created
// from an earlier build keep working untouched.
const COMPOSITE_CACHE_MAX_ENTRIES = 32;
const compositeCache = new Map<string, Promise<HTMLCanvasElement | null>>();

async function buildComposite(
  appearance: AppearanceLayers,
  manifest: CharacterManifest
): Promise<HTMLCanvasElement | null> {
  const normalized = normalizeAppearance(appearance);
  const files: string[] = [];
  for (const layer of CHARACTER_LAYER_ORDER) {
    const pieceId = normalized[layer];
    if (!pieceId) continue;
    const file = pieceFile(manifest, layer, pieceId);
    // A selected piece id that's no longer in the manifest (stale
    // selection from a regenerated asset pack) fails the WHOLE composite
    // closed rather than silently rendering with a missing layer — the
    // caller falls back to the placeholder sprite, same as any other load
    // failure (never throws).
    if (!file) return null;
    files.push(file);
  }
  if (files.length === 0) return null;

  const images = await Promise.all(files.map(loadPieceImage));
  if (images.some((img) => img === null)) return null;

  if (typeof document === "undefined") return null; // SSR/non-browser guard
  const canvas = document.createElement("canvas");
  canvas.width = COMPOSITE_SHEET_W;
  canvas.height = COMPOSITE_SHEET_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  WALK_DIRS.forEach((dir, rowIdx) => {
    const rects = walkFrameRects(dir);
    rects.forEach((rect, colIdx) => {
      const dx = colIdx * CHAR_FRAME.w;
      const dy = rowIdx * CHAR_FRAME.h;
      for (const img of images) {
        if (!img) continue;
        if (rect.flipX) {
          ctx.save();
          ctx.translate(dx + CHAR_FRAME.w, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(img, rect.sx, rect.sy, rect.w, rect.h, 0, 0, rect.w, rect.h);
          ctx.restore();
        } else {
          ctx.drawImage(img, rect.sx, rect.sy, rect.w, rect.h, dx, dy, rect.w, rect.h);
        }
      }
    });
  });

  return canvas;
}

/**
 * Composites `appearance` into an offscreen walk-cycle sheet canvas
 * (COMPOSITE_SHEET_W x COMPOSITE_SHEET_H — 3 frames x 4 directions, 32x64
 * each), or resolves `null` (never throws/rejects) when the appearance is
 * empty, the manifest isn't loaded yet, or any part PNG fails to load —
 * callers must fall back to the placeholder sprite in that case. Results
 * are cached module-wide by `appearanceKey`, so two agents (or an
 * AgentPanel preview + OfficeCanvas render) sharing the same picks only
 * composite once.
 */
export function compositeCharacter(
  appearance: AppearanceLayers | null | undefined,
  manifest: CharacterManifest | null
): Promise<HTMLCanvasElement | null> {
  if (!manifest || isEmptyAppearance(appearance)) return Promise.resolve(null);
  const key = appearanceKey(appearance);
  const existing = compositeCache.get(key);
  if (existing) {
    lruTouch(compositeCache, key, existing); // hit: refresh recency
    return existing;
  }
  const pending = buildComposite(appearance!, manifest).catch(() => null);
  lruSet(compositeCache, key, pending, COMPOSITE_CACHE_MAX_ENTRIES);
  return pending;
}

/** Source rect (within a composite sheet OR, with the same col/row
 * convention, the raw Character Pieces sheet) for one specific walk-cycle
 * step: `stepIndex` 0/1/2 = left-step/stand/right-step per
 * `character_frames.ts`'s `WalkRowSpec.cols` doc. Used by AgentPanel's
 * still preview (stand frame, facing down) so it can crop a single frame
 * out of the same composite `compositeCharacter` already builds instead of
 * re-drawing anything. */
export function standingFrameRect(dir: WalkDir = "down"): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const rowIdx = WALK_DIRS.indexOf(dir);
  return { x: CHAR_FRAME.w * 1, y: CHAR_FRAME.h * rowIdx, w: CHAR_FRAME.w, h: CHAR_FRAME.h };
}
