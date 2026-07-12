"use client";

// PixiJS v8 office renderer (Phase 1 T1.4).
//
// Static layers (floor/walls) come from the tmj + placeholder tileset in
// /public; the furniture layer is rebuilt from every world_snapshot (so a
// page reload or reconnect restores it — acceptance requirement); agents
// are AnimatedSprites (4 directions x 3 frames) with name labels, whose
// positions interpolate toward the last agent_moved tile at the current
// tick pace.

import { useEffect, useRef } from "react";
import {
  AnimatedSprite,
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";
import { apiJson } from "@/api/client";
import {
  appearanceKey,
  compositeCharacter,
  isEmptyAppearance,
} from "@/lib/character_compositor";
import { CHAR_FRAME } from "@/lib/character_frames";
import { useGameStore } from "./store";
import {
  footprintOf,
  type AgentRow,
  type CharacterManifest,
  type FurnitureManifest,
  type FurnitureManifestEntry,
  type LayoutItemRow,
} from "./types";

const TILE = 32;

// The Pixi render target ("viewport") is a fixed pixel size, decoupled
// from the loaded map's actual width/height — this is what makes camera
// zoom/pan meaningful (map bigger than viewport -> zoomed in by default;
// smaller -> letterboxed) instead of the map always exactly filling the
// canvas. Sized to the legacy default map (48x32) so that map's `fit`
// view (zoom=1, centered) is pixel-identical to the pre-camera baseline.
const VIEWPORT_TILES_W = 48;
const VIEWPORT_TILES_H = 32;
const VIEWPORT_W = VIEWPORT_TILES_W * TILE;
const VIEWPORT_H = VIEWPORT_TILES_H * TILE;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const WHEEL_ZOOM_STEP = 1.1;

// Mirrors app/page.tsx's mock-mode flag: in mock mode the map comes from
// the static /maps/office_shell.tmj fixture (no engine to GET from); in
// live mode it comes from the store's cached GET /api/v1/world/map,
// refetched whenever world.map_rev disagrees with the cache (ADR-002 D2).
const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_SNAPSHOT === "1";

// Direction rows in the generated spritesheets (scripts/gen_agent_sprites.mjs).
const DIR_DOWN = 0;
const DIR_LEFT = 1;
const DIR_RIGHT = 2;
const DIR_UP = 3;

// Walk-cycle animation rate at store speed=1, and the multiplier cap so the
// legs don't flicker unreadably fast at the x5 time control (spec 7.1).
const ANIM_SPEED_BASE = 0.12;
const ANIM_SPEED_MAX = 0.6;

const FURNITURE_COLORS: Record<LayoutItemRow["kind"], number> = {
  desk: 0x8a6f4d,
  exec_desk: 0x6e5238,
  chair: 0xb0b7c1,
  partition: 0x77808f,
  meeting_table: 0x7a5f43,
  cabinet: 0x708090,
  printer: 0x4d5661,
  plant: 0x3f7d46,
  pantry_counter: 0x9a7b52,
  whiteboard: 0xe8e8ec,
};

const FURNITURE_KINDS = new Set(
  Object.keys(FURNITURE_COLORS) as LayoutItemRow["kind"][]
);
let furnitureSpriteLoadWarned = false;

type FurnitureSpriteFit = "contain" | "cover" | "stretch";

interface FurnitureSpriteEntry {
  texture: Texture;
  fit: FurnitureSpriteFit;
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface AgentVisual {
  root: Container;
  sprite: AnimatedSprite;
  label: Text;
  texturesByDir: Texture[][];
  dir: number;
  targetX: number;
  targetY: number;
  status: string;
  /** Frame height currently applied (TILE=32 for the generated placeholder
   * sheet, CHAR_FRAME.h=64 for a composited custom-appearance sheet) — the
   * extra height grows upward from the tile's bottom edge so feet stay
   * planted; see `visualOffsetY`. */
  frameH: number;
  /** `appearanceKey(agent.appearance)` this visual's textures currently
   * reflect. `syncAgents` compares this against the live agent on every
   * snapshot and, on a mismatch, swaps just the textures/offsets in place
   * (`applyAppearance`) rather than rebuilding the whole Container — ADR-003
   * D3 "appearance 變更 → 換 texture 不重建整個 visual". */
  appearanceKey: string;
}

/** Vertical sprite offset so a `frameH`-tall sprite's BOTTOM edge lands on
 * the tile's own bottom edge (y=TILE within `root`), same as the
 * TILE-tall placeholder always has — a taller (32x64) composited sheet
 * grows entirely upward (head room), never shifting the feet. */
function visualOffsetY(frameH: number): number {
  return TILE - frameH;
}

interface TmjDoc {
  width: number;
  height: number;
  layers: { type: string; name: string; data: number[] }[];
  tilesets: { firstgid: number; image: string; tilewidth: number }[];
}

function sliceTileset(sheet: Texture, count: number): Texture[] {
  const out: Texture[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      new Texture({
        source: sheet.source,
        frame: new Rectangle(i * TILE, 0, TILE, TILE),
      })
    );
  }
  return out;
}

function sliceSpriteSheet(sheet: Texture): Texture[][] {
  const byDir: Texture[][] = [];
  for (let dir = 0; dir < 4; dir++) {
    const frames: Texture[] = [];
    for (let col = 0; col < 3; col++) {
      frames.push(
        new Texture({
          source: sheet.source,
          frame: new Rectangle(col * TILE, dir * TILE, TILE, TILE),
        })
      );
    }
    byDir.push(frames);
  }
  return byDir;
}

// ADR-003 D3: same 4-direction x 3-frame slicing as `sliceSpriteSheet`
// above, but for a browser-composited character sheet
// (character_compositor.ts's COMPOSITE_SHEET_W x COMPOSITE_SHEET_H canvas,
// wrapped in `Texture.from(canvas)` by the caller). Frames are CHAR_FRAME
// (32x64) instead of TILE (32x32) — the row order matches
// DIR_DOWN/DIR_LEFT/DIR_RIGHT/DIR_UP exactly (both this sheet and
// character_frames.ts's WALK_DIRS use down/left/right/up), so row index
// doubles as the same dir constant with no remapping.
function sliceCharacterSheet(sheet: Texture): Texture[][] {
  const byDir: Texture[][] = [];
  for (let dir = 0; dir < 4; dir++) {
    const frames: Texture[] = [];
    for (let col = 0; col < 3; col++) {
      frames.push(
        new Texture({
          source: sheet.source,
          frame: new Rectangle(
            col * CHAR_FRAME.w,
            dir * CHAR_FRAME.h,
            CHAR_FRAME.w,
            CHAR_FRAME.h
          ),
        })
      );
    }
    byDir.push(frames);
  }
  return byDir;
}

function isFurnitureKind(value: string): value is LayoutItemRow["kind"] {
  return FURNITURE_KINDS.has(value as LayoutItemRow["kind"]);
}

function warnFurnitureSpriteLoadFailure(err: unknown) {
  if (furnitureSpriteLoadWarned) return;
  furnitureSpriteLoadWarned = true;
  console.warn(
    "[sim] LimeZu furniture sprite failed to load; using generated placeholder",
    err
  );
}

// ADR-003 D2: the manifest itself (sprites/catalog/categories JSON) is
// fetched once and shared via the store (`ensureFurnitureManifestLoaded`,
// also used by LayoutEditorPanel's material browser) — this module no
// longer does its own `fetch`. What stays local to this module is turning
// manifest entries into Pixi *textures*, which is done lazily/on-demand
// (see `ensureMaterialSprite` below) instead of eagerly walking the whole
// (5800+ entry) catalog at mount: a given map only ever places a handful
// of distinct materials, so there is no reason to pre-decode thousands of
// PNGs nobody is using.
//
// `Assets.load` dedupes concurrent/repeated loads of the same URL via its
// own global cache, so this is safe to call redundantly — callers
// additionally gate on their own id-keyed cache (`materialTextureCache`
// below, mirroring the agent-visual `visuals`/`resolvedVisuals` pattern)
// so a given material is only ever requested once per mount, not once per
// tile per redraw.
async function loadSpriteEntry(
  spriteDef: FurnitureManifestEntry
): Promise<FurnitureSpriteEntry | null> {
  if (!spriteDef.image) return null;
  try {
    const baseTexture = (await Assets.load(spriteDef.image)) as Texture;
    baseTexture.source.scaleMode = "nearest";
    const hasFrame =
      spriteDef.x !== undefined ||
      spriteDef.y !== undefined ||
      spriteDef.w !== undefined ||
      spriteDef.h !== undefined;
    const texture = hasFrame
      ? new Texture({
          source: baseTexture.source,
          frame: new Rectangle(
            spriteDef.x ?? 0,
            spriteDef.y ?? 0,
            spriteDef.w ?? TILE,
            spriteDef.h ?? TILE
          ),
        })
      : baseTexture;
    return {
      texture,
      fit: spriteDef.fit ?? "contain",
      scale: spriteDef.scale ?? 1,
      offsetX: spriteDef.offsetX ?? 0,
      offsetY: spriteDef.offsetY ?? 0,
    };
  } catch (err) {
    warnFurnitureSpriteLoadFailure(err);
    return null;
  }
}

function drawFurniturePlaceholder(g: Graphics, item: LayoutItemRow) {
  const fp = footprintOf(item);
  const px = fp.x * TILE;
  const py = fp.y * TILE;
  const w = fp.w * TILE;
  const h = fp.h * TILE;
  const color = FURNITURE_COLORS[item.kind] ?? 0x888888;
  if (item.kind === "plant") {
    g.circle(px + w / 2, py + h / 2, w * 0.38).fill(color);
    g.circle(px + w / 2, py + h * 0.72, w * 0.18).fill(0x6b4a2f); // pot
  } else if (item.kind === "chair") {
    g.roundRect(px + 7, py + 7, w - 14, h - 14, 4).fill(color);
  } else {
    g.rect(px + 2, py + 2, w - 4, h - 4).fill(color);
    g.rect(px + 2, py + 2, w - 4, 3).fill(0xffffff, 0.12); // top light
  }
}

function addFurnitureSprite(
  spriteLayer: Container,
  spriteDef: FurnitureSpriteEntry,
  item: LayoutItemRow
) {
  const fp = footprintOf(item);
  const px = fp.x * TILE;
  const py = fp.y * TILE;
  const w = fp.w * TILE;
  const h = fp.h * TILE;
  const sprite = new Sprite(spriteDef.texture);
  const texW = Math.max(sprite.texture.width, 1);
  const texH = Math.max(sprite.texture.height, 1);

  if (spriteDef.fit === "stretch") {
    sprite.x = px + spriteDef.offsetX;
    sprite.y = py + spriteDef.offsetY;
    sprite.width = w * spriteDef.scale;
    sprite.height = h * spriteDef.scale;
  } else {
    const fitScale =
      spriteDef.fit === "cover"
        ? Math.max(w / texW, h / texH)
        : Math.min(w / texW, h / texH);
    const scale = fitScale * spriteDef.scale;
    sprite.scale.set(scale);
    sprite.x = px + (w - texW * scale) / 2 + spriteDef.offsetX;
    sprite.y = py + (h - texH * scale) / 2 + spriteDef.offsetY;
  }

  spriteLayer.addChild(sprite);
}

// Full sprite meta (fit/scale/offset included, not just id/image) so the
// lazy per-material loader below can build a correctly-fitted
// FurnitureSpriteEntry straight from what LayoutEditorPanel stored.
function readSpriteMeta(meta: unknown): FurnitureManifestEntry | undefined {
  if (!isPlainRecord(meta)) return undefined;
  const sprite = meta.sprite;
  if (!isPlainRecord(sprite) || typeof sprite.image !== "string") return undefined;
  return {
    id: typeof sprite.id === "string" ? sprite.id : undefined,
    label: typeof sprite.label === "string" ? sprite.label : undefined,
    file: typeof sprite.file === "string" ? sprite.file : undefined,
    image: sprite.image,
    fit:
      sprite.fit === "contain" || sprite.fit === "cover" || sprite.fit === "stretch"
        ? sprite.fit
        : "contain",
    scale: typeof sprite.scale === "number" ? sprite.scale : undefined,
    offsetX: typeof sprite.offsetX === "number" ? sprite.offsetX : undefined,
    offsetY: typeof sprite.offsetY === "number" ? sprite.offsetY : undefined,
  };
}

/** Cache key for one material: id when present (stable across a manifest
 * regen that might reshuffle paths), else the image URL. */
function materialKeyFor(spriteMeta: FurnitureManifestEntry): string {
  return spriteMeta.id ?? spriteMeta.image ?? "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function drawGrid(
  container: Container,
  visible: boolean,
  widthTiles: number,
  heightTiles: number
) {
  let g = container.children[0] as Graphics | undefined;
  if (!g) {
    g = new Graphics();
    container.addChild(g);
  } else {
    g.clear();
  }
  container.visible = visible;
  if (!visible) return;
  for (let x = 0; x <= widthTiles; x++) {
    g.moveTo(x * TILE, 0).lineTo(x * TILE, heightTiles * TILE).stroke({
      color: 0x66d9ef,
      alpha: 0.16,
      width: 1,
    });
  }
  for (let y = 0; y <= heightTiles; y++) {
    g.moveTo(0, y * TILE).lineTo(widthTiles * TILE, y * TILE).stroke({
      color: 0x66d9ef,
      alpha: 0.16,
      width: 1,
    });
  }
}

/** Fetches the current map from the engine and caches it in the store
 * (ADR-002 D2). Returns `null` (and logs a warning) on any failure — e.g.
 * the engine isn't running yet, or the world isn't loaded (503) — so
 * callers can degrade to an empty map layer instead of crashing; the
 * map_rev-driven refetch (see `ensureFreshMap` below) retries once a
 * world_snapshot eventually arrives over `/ws`. */
async function fetchLiveMap(): Promise<TmjDoc | null> {
  try {
    const res = await apiJson<{ tmj: TmjDoc; map_rev: number }>(
      "/api/v1/world/map"
    );
    useGameStore.getState().setMap(res.tmj, res.map_rev);
    return res.tmj;
  } catch (err) {
    console.warn("[sim] failed to load live map from /api/v1/world/map", err);
    return null;
  }
}

export default function OfficeCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitViewRef = useRef<(() => void) | null>(null);
  const oneToOneViewRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let app: Application | null = null;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      const created = new Application();
      await created.init({
        width: VIEWPORT_W,
        height: VIEWPORT_H,
        background: 0x14161c,
        antialias: false,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      // React 18 strict mode double-mounts effects: bail out if this
      // mount was already cleaned up while init() was in flight.
      if (cancelled) {
        created.destroy(true);
        return;
      }
      app = created;
      host.appendChild(app.canvas);
      app.canvas.style.width = "100%";
      app.canvas.style.height = "auto";
      app.canvas.style.touchAction = "none";
      app.canvas.style.cursor = "grab";

      // ---- Camera (ADR-002 D4: wheel zoom + drag pan + fit/1:1) -------
      // All four content layers live under `camera`, whose scale/position
      // is the pan/zoom transform; `app.stage` itself stays untransformed.
      const camera = new Container();
      const mapLayer = new Container();
      const furnitureLayer = new Container();
      const gridLayer = new Container();
      const agentLayer = new Container();
      camera.addChild(mapLayer, furnitureLayer, gridLayer, agentLayer);
      app.stage.addChild(camera);

      // Current map size in tiles — starts at the viewport's own baseline
      // and is updated by loadAndBuildMap() once a real map loads.
      let mapTilesW = VIEWPORT_TILES_W;
      let mapTilesH = VIEWPORT_TILES_H;
      let zoom = 1;

      // W3 fix: ZOOM_MIN=0.5 was a hardcoded floor that couldn't zoom out
      // far enough to fit a room bigger than the 48x32 baseline (legal
      // room sizes go up to 96x96 — see office_shell_core MAX_SIZE) — both
      // "fit to map" and manual wheel-zoom-out got stuck unable to show
      // the whole room. The effective floor is now whichever is SMALLER:
      // the original 0.5 floor, or the zoom level that exactly fits the
      // current map in the viewport (so "fit" is always reachable and
      // never clamped away).
      function fitZoomFor(tilesW: number, tilesH: number) {
        return Math.min(VIEWPORT_W / (tilesW * TILE), VIEWPORT_H / (tilesH * TILE));
      }

      const clampZoom = (z: number) => {
        const zoomMin = Math.min(ZOOM_MIN, fitZoomFor(mapTilesW, mapTilesH));
        return Math.min(ZOOM_MAX, Math.max(zoomMin, z));
      };

      function clampCamera() {
        const scaledW = mapTilesW * TILE * zoom;
        const scaledH = mapTilesH * TILE * zoom;
        camera.x =
          scaledW <= VIEWPORT_W
            ? (VIEWPORT_W - scaledW) / 2
            : Math.min(0, Math.max(VIEWPORT_W - scaledW, camera.x));
        camera.y =
          scaledH <= VIEWPORT_H
            ? (VIEWPORT_H - scaledH) / 2
            : Math.min(0, Math.max(VIEWPORT_H - scaledH, camera.y));
      }

      // Zooms so the map point currently under (screenX, screenY) —
      // viewport pixel coordinates, i.e. already converted from client
      // (CSS) coordinates — stays under the same point after the zoom.
      function setZoomAtScreenPoint(nextZoom: number, screenX: number, screenY: number) {
        const clamped = clampZoom(nextZoom);
        const worldX = (screenX - camera.x) / zoom;
        const worldY = (screenY - camera.y) / zoom;
        zoom = clamped;
        camera.scale.set(zoom);
        camera.x = screenX - worldX * zoom;
        camera.y = screenY - worldY * zoom;
        clampCamera();
      }

      function fitView() {
        zoom = clampZoom(fitZoomFor(mapTilesW, mapTilesH));
        camera.scale.set(zoom);
        clampCamera();
      }

      function oneToOneView() {
        zoom = clampZoom(1);
        camera.scale.set(zoom);
        clampCamera();
      }

      fitViewRef.current = fitView;
      oneToOneViewRef.current = oneToOneView;

      function isEditingNow() {
        // W1/W4 fix: read the store's local-only `editorActive` flag
        // instead of `world.status === "editing"` — the latter gets
        // clobbered by any incoming world_snapshot (see store.ts).
        // Tab-aware (指揮官裁決 2026-07-12): the camera lock + grid only
        // apply while the editor tab is actually fronted. An open draft on
        // a background tab keeps `editorActive` true (W1's draft lifecycle
        // is untouched) but must not freeze the monitor tab's wheel/drag
        // nor overlay its cyan grid.
        const state = useGameStore.getState();
        return state.editorActive && state.activeTab === "editor";
      }

      function screenPointFromClient(clientX: number, clientY: number) {
        const rect = app!.canvas.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / rect.width) * VIEWPORT_W,
          y: ((clientY - rect.top) / rect.height) * VIEWPORT_H,
        };
      }

      function onWheel(event: WheelEvent) {
        // Editing mode: back off entirely so this canvas never competes
        // with the layout editor's own board for wheel/scroll events.
        if (isEditingNow()) return;
        event.preventDefault();
        const { x, y } = screenPointFromClient(event.clientX, event.clientY);
        setZoomAtScreenPoint(
          zoom * (event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP),
          x,
          y
        );
      }

      let dragging = false;
      let dragPointerId: number | null = null;
      let dragStartClientX = 0;
      let dragStartClientY = 0;
      let dragStartCamX = 0;
      let dragStartCamY = 0;

      function onPointerDown(event: PointerEvent) {
        if (isEditingNow()) return;
        dragging = true;
        dragPointerId = event.pointerId;
        dragStartClientX = event.clientX;
        dragStartClientY = event.clientY;
        dragStartCamX = camera.x;
        dragStartCamY = camera.y;
        app!.canvas.setPointerCapture(event.pointerId);
        app!.canvas.style.cursor = "grabbing";
        event.preventDefault();
      }

      function onPointerMove(event: PointerEvent) {
        if (!dragging || event.pointerId !== dragPointerId) return;
        const rect = app!.canvas.getBoundingClientRect();
        camera.x =
          dragStartCamX + ((event.clientX - dragStartClientX) / rect.width) * VIEWPORT_W;
        camera.y =
          dragStartCamY + ((event.clientY - dragStartClientY) / rect.height) * VIEWPORT_H;
        clampCamera();
      }

      function endDrag(event: PointerEvent) {
        if (dragPointerId === null || event.pointerId !== dragPointerId) return;
        dragging = false;
        if (app!.canvas.hasPointerCapture(event.pointerId)) {
          app!.canvas.releasePointerCapture(event.pointerId);
        }
        dragPointerId = null;
        app!.canvas.style.cursor = isEditingNow() ? "default" : "grab";
      }

      app.canvas.addEventListener("wheel", onWheel, { passive: false });
      app.canvas.addEventListener("pointerdown", onPointerDown);
      app.canvas.addEventListener("pointermove", onPointerMove);
      app.canvas.addEventListener("pointerup", endDrag);
      app.canvas.addEventListener("pointercancel", endDrag);

      let lastLayout: LayoutItemRow[] | null = null;
      let lastAgents: Record<string, AgentRow> | null = null;
      let lastEditing = false;
      let lastFurnitureManifest: FurnitureManifest | null = null;
      let lastCharacterManifest: CharacterManifest | null = null;

      // ---- Furniture sprites (ADR-003 D2) ------------------------------
      // Kind-level defaults (10 entries, from manifest.sprites) are small
      // enough to load eagerly whenever the manifest becomes available.
      // Per-material sprites (an item's own `meta.sprite`, chosen in
      // LayoutEditorPanel) stay lazy: a map might reference any of the
      // manifest's 5800+ catalog entries, but only ever a handful at once,
      // so each is fetched only the first time an actual layout item needs
      // it — mirrors the agent-visual `visuals`/`resolvedVisuals`
      // pending/resolved pair further below (register the promise
      // synchronously so concurrent draws of the same item can't double-fetch).
      let kindSprites: Partial<Record<LayoutItemRow["kind"], FurnitureSpriteEntry>> = {};
      const materialTextureCache = new Map<string, Promise<FurnitureSpriteEntry | null>>();
      const resolvedMaterialTextures = new Map<string, FurnitureSpriteEntry>();

      function ensureMaterialTexture(key: string, spriteMeta: FurnitureManifestEntry) {
        if (!key || materialTextureCache.has(key)) return;
        const pending = loadSpriteEntry(spriteMeta).then((entry) => {
          if (cancelled) return entry;
          if (entry) {
            resolvedMaterialTextures.set(key, entry);
            // Upgrade whatever was already drawn (kind default / color
            // block) to the real material now that it's ready.
            if (lastLayout) drawFurniture(furnitureLayer, lastLayout);
          }
          return entry;
        });
        materialTextureCache.set(key, pending);
      }

      function spriteEntryForItem(item: LayoutItemRow): FurnitureSpriteEntry | undefined {
        const spriteMeta = readSpriteMeta(item.meta);
        if (spriteMeta) {
          const key = materialKeyFor(spriteMeta);
          const resolved = key ? resolvedMaterialTextures.get(key) : undefined;
          if (resolved) return resolved;
          // Not loaded yet: kick off the (idempotent, per-key) load and,
          // for THIS frame, fall through to the kind-level default rather
          // than the flat color block — closer to the final look while the
          // specific material streams in, and `drawFurniture` re-runs once
          // it resolves.
          ensureMaterialTexture(key, spriteMeta);
        }
        return kindSprites[item.kind];
      }

      function drawFurniture(container: Container, layout: LayoutItemRow[]) {
        // Keep one persistent Graphics for fallback placeholders. Sprite
        // children are destroyed on each layout redraw, while the Graphics
        // is cleared in place to avoid leaking GPU geometry during frequent
        // world_snapshot updates.
        let g = container.children[0] as Graphics | undefined;
        let spriteLayer = container.children[1] as Container | undefined;
        if (!g) {
          g = new Graphics();
          container.addChild(g);
        } else {
          g.clear();
        }
        if (!spriteLayer) {
          spriteLayer = new Container();
          container.addChild(spriteLayer);
        }
        for (const child of spriteLayer.removeChildren()) {
          child.destroy({ children: true });
        }

        for (const item of layout) {
          const spriteDef = spriteEntryForItem(item);
          if (spriteDef) {
            addFurnitureSprite(spriteLayer, spriteDef, item);
          } else {
            drawFurniturePlaceholder(g, item);
          }
        }
      }

      async function applyFurnitureManifest(manifest: FurnitureManifest) {
        const byKind: Partial<Record<LayoutItemRow["kind"], FurnitureSpriteEntry>> = {};
        for (const [kind, spriteDef] of Object.entries(manifest.sprites ?? {})) {
          if (!isFurnitureKind(kind) || !spriteDef.image) continue;
          const entry = await loadSpriteEntry(spriteDef);
          if (entry) byKind[kind] = entry;
        }
        if (cancelled) return;
        kindSprites = byKind;
        if (lastLayout) drawFurniture(furnitureLayer, lastLayout);
      }

      // ADR-003 D2: idempotent across components — if LayoutEditorPanel (or
      // an earlier mount of this component) already triggered the fetch,
      // this is a no-op and we just read whatever's already cached/loading.
      // NOTE: this `getState()` read right after kicking off the fetch is
      // realistically ALWAYS null (the fetch can't resolve synchronously) —
      // it's a harmless fast-path, not the real load path. The manifest
      // actually gets applied by the equivalent check placed right before
      // `useGameStore.subscribe()` below, which is what closes the race
      // that caused the color-block regression (see the comment there).
      useGameStore.getState().ensureFurnitureManifestLoaded();
      const initialFurnitureManifest = useGameStore.getState().furnitureManifest;
      if (initialFurnitureManifest) {
        lastFurnitureManifest = initialFurnitureManifest;
        void applyFurnitureManifest(initialFurnitureManifest);
      }
      // ADR-003 D3: same idempotent-fetch kickoff for the character
      // manifest. `lastCharacterManifest` (declared further below, once
      // `characterTextureCache` exists) is what actually reacts to it
      // arriving — this call just ensures the fetch is in flight as early
      // as possible regardless of which component mounts first.
      useGameStore.getState().ensureCharacterManifestLoaded();

      // ---- Map from tmj + tileset -------------------------------------
      // Live mode: TMJ comes from the store's GET /api/v1/world/map cache
      // (fetched below / refetched on map_rev change). Mock mode keeps
      // reading the static fixture file — there's no engine to GET from.
      async function loadAndBuildMap(tmj: TmjDoc) {
        const tilesetUrl = new URL(
          tmj.tilesets[0].image,
          new URL("/maps/", window.location.href)
        ).pathname;
        const sheet = (await Assets.load(tilesetUrl)) as Texture;
        sheet.source.scaleMode = "nearest";
        if (cancelled) return;
        buildMapLayer(tmj, sheet);
        fitView();
      }

      function buildMapLayer(tmj: TmjDoc, sheet: Texture) {
        for (const child of mapLayer.removeChildren()) {
          child.destroy();
        }
        const tiles = sliceTileset(sheet, 4);
        const firstgid = tmj.tilesets[0].firstgid;
        for (const layer of tmj.layers) {
          if (layer.type !== "tilelayer") continue;
          for (let i = 0; i < layer.data.length; i++) {
            const gid = layer.data[i];
            if (gid === 0) continue;
            const tex = tiles[gid - firstgid];
            if (!tex) continue;
            const sprite = new Sprite(tex);
            sprite.x = (i % tmj.width) * TILE;
            sprite.y = Math.floor(i / tmj.width) * TILE;
            mapLayer.addChild(sprite);
          }
        }
        mapTilesW = tmj.width;
        mapTilesH = tmj.height;
      }

      // Fetches the freshest map when the store's cached `mapRev`
      // disagrees with the latest `world.map_rev` (subscriber-side
      // comparison — see notes_for_wave3 for why this beat a store flag).
      // Also covers the "haven't fetched anything yet" case (`mapTmj ===
      // null`), since a brand-new store's `mapRev` defaults to `1`, same
      // as a snapshot that hasn't touched the map — a bare rev compare
      // would otherwise miss the very first fetch.
      let mapFetchInFlight = false;
      async function ensureFreshMap() {
        if (MOCK_MODE || mapFetchInFlight) return;
        const state = useGameStore.getState();
        const wantRev = state.world?.map_rev ?? 1;
        if (state.mapTmj !== null && wantRev === state.mapRev) return;
        mapFetchInFlight = true;
        try {
          const fresh = await fetchLiveMap();
          if (fresh && !cancelled) await loadAndBuildMap(fresh);
        } finally {
          mapFetchInFlight = false;
        }
      }

      let initialTmj: TmjDoc | null = null;
      if (MOCK_MODE) {
        try {
          initialTmj = await (await fetch("/maps/office_shell.tmj")).json();
          // W7 fix: the live branch (fetchLiveMap) populates the store's
          // mapTmj/mapRev as a side effect; this mock branch fetched the
          // tmj but never told the store, so mapTmj stayed `null` forever
          // in mock mode — world settings showed the fallback dims and
          // wall-overlap validation silently skipped. Mirror fetchLiveMap
          // here too.
          if (initialTmj) {
            useGameStore
              .getState()
              .setMap(initialTmj, useGameStore.getState().world?.map_rev ?? 1);
          }
        } catch (err) {
          console.warn("[sim] failed to load mock map", err);
        }
      } else {
        initialTmj = await fetchLiveMap();
      }
      if (cancelled) return;
      if (initialTmj) {
        await loadAndBuildMap(initialTmj);
      } else {
        // No map yet (engine unreachable / world not loaded): establish a
        // baseline camera at the viewport's own size so fit/1:1 and
        // wheel/drag still work once ensureFreshMap() picks up a map.
        fitView();
      }
      if (cancelled) return;

      // ---- Dynamic layers driven by the store ------------------------
      // Keyed by agent id. Holds an in-flight *promise* for the visual,
      // registered synchronously (before any await) the first time an
      // agent is seen. Concurrent syncAgents() calls for the same agent
      // (e.g. the snapshot's syncAgents racing an agent_moved-triggered
      // syncAgents right after reconnect) therefore all await the SAME
      // promise instead of each independently reaching `visuals.set` after
      // their own Assets.load — which used to build two sprite/label
      // Containers and addChild both, leaving a frozen duplicate ("ghost")
      // for whichever one lost the race. The map is the single source of
      // truth for both creation and the cleanup sweep below, so this
      // makes a duplicate addChild structurally impossible rather than a
      // matter of timing luck.
      const visuals = new Map<string, Promise<AgentVisual>>();
      // Resolved mirror of `visuals`, kept in sync as each promise settles.
      // The per-frame ticker below runs synchronously (PixiJS ticker
      // callback) and only needs cheap read access to already-built
      // visuals, so it iterates this instead of awaiting `visuals`.
      const resolvedVisuals = new Map<string, AgentVisual>();
      const lastVisualLoadWarnAt = new Map<string, number>();
      const labelStyle = new TextStyle({
        fontFamily: 'system-ui, "PingFang TC", "Noto Sans TC", sans-serif',
        fontSize: 12,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3 },
      });

      // ADR-003 D3: custom-appearance textures, cached by appearanceKey (not
      // by agent id) — two agents wearing the identical outfit share one
      // composited/sliced texture set, and the promise itself is the
      // in-flight guard (mirrors `materialTextureCache` above / `visuals`
      // below): a second concurrent call for the same key gets the same
      // promise instead of re-compositing. Resolves `null` (never rejects)
      // when the manifest isn't loaded yet or the composite failed, so
      // callers fall back to the placeholder sheet.
      const characterTextureCache = new Map<string, Promise<Texture[][] | null>>();

      function ensureCharacterTexture(
        key: string,
        appearance: AgentRow["appearance"]
      ): Promise<Texture[][] | null> {
        const existing = characterTextureCache.get(key);
        if (existing) return existing;
        const pending = compositeCharacter(
          appearance,
          useGameStore.getState().characterManifest
        )
          .then((canvas) => {
            if (!canvas) return null;
            const tex = Texture.from(canvas);
            tex.source.scaleMode = "nearest";
            return sliceCharacterSheet(tex);
          })
          .catch(() => null);
        characterTextureCache.set(key, pending);
        return pending;
      }

      /** Resolves the texturesByDir + frame height to use for `agent` right
       * now: the composited custom-appearance sheet when one is selected
       * AND composites successfully, else the generated placeholder sheet
       * (agent's own `sprite_key`.png — always present, never fails per
       * ADR-003 D3's "appearance＝null 永不回退失敗"). */
      async function resolveVisualTextures(
        agent: AgentRow
      ): Promise<{ texturesByDir: Texture[][]; frameH: number }> {
        const key = appearanceKey(agent.appearance);
        if (!isEmptyAppearance(agent.appearance)) {
          const custom = await ensureCharacterTexture(key, agent.appearance);
          if (custom) return { texturesByDir: custom, frameH: CHAR_FRAME.h };
        }
        const sheetTex = (await Assets.load(
          `/sprites/agents/${agent.sprite_key}.png`
        )) as Texture;
        sheetTex.source.scaleMode = "nearest";
        return { texturesByDir: sliceSpriteSheet(sheetTex), frameH: TILE };
      }

      async function buildVisual(agent: AgentRow): Promise<AgentVisual> {
        const { texturesByDir, frameH } = await resolveVisualTextures(agent);
        const offsetY = visualOffsetY(frameH);
        const sprite = new AnimatedSprite(texturesByDir[DIR_DOWN]);
        sprite.animationSpeed = ANIM_SPEED_BASE;
        sprite.gotoAndStop(1);
        sprite.y = offsetY;
        const label = new Text({ text: agent.name, style: labelStyle });
        label.anchor.set(0.5, 1);
        label.x = TILE / 2;
        label.y = offsetY - 2;
        const root = new Container();
        root.addChild(sprite, label);
        root.visible = false;
        agentLayer.addChild(root);
        const visual: AgentVisual = {
          root,
          sprite,
          label,
          texturesByDir,
          dir: DIR_DOWN,
          targetX: agent.pos_x * TILE,
          targetY: agent.pos_y * TILE,
          status: agent.current_status,
          frameH,
          appearanceKey: appearanceKey(agent.appearance),
        };
        root.x = visual.targetX;
        root.y = visual.targetY;
        return visual;
      }

      /** ADR-003 D3: "appearance 變更 → 換 texture 不重建整個 visual". Called
       * from `syncAgents` for every already-resolved visual on every
       * snapshot; no-ops (synchronously, before any await) unless the
       * agent's current appearance key actually differs from what this
       * visual last applied — cheap enough to call unconditionally per
       * sync. Setting `v.appearanceKey` BEFORE the await is the
       * concurrency guard: a second call landing while this one is still
       * in flight (two snapshots arriving close together) sees the key
       * already matches and bails immediately, same spirit as
       * `ensureVisual`'s promise-map guard but for an in-place field swap
       * rather than a whole new Container. */
      async function applyAppearance(agent: AgentRow, v: AgentVisual) {
        const key = appearanceKey(agent.appearance);
        if (key === v.appearanceKey) return;
        const previousKey = v.appearanceKey;
        v.appearanceKey = key;
        let resolved: { texturesByDir: Texture[][]; frameH: number };
        try {
          resolved = await resolveVisualTextures(agent);
        } catch (err) {
          // resolveVisualTextures's placeholder fallback (Assets.load) can
          // still reject on a transient failure. Revert appearanceKey to
          // what this visual last successfully applied so the NEXT
          // syncAgents() pass retries instead of permanently treating the
          // failed key as "already applied" (self-heal, mirrors
          // ensureVisual's evict-and-retry contract) — and never let this
          // fire-and-forget call surface as an unhandled rejection.
          v.appearanceKey = previousKey;
          console.warn(`[sim] appearance swap failed for ${agent.name}`, err);
          return;
        }
        if (cancelled || resolvedVisuals.get(agent.id) !== v) return;
        const { texturesByDir, frameH } = resolved;
        v.texturesByDir = texturesByDir;
        v.frameH = frameH;
        const offsetY = visualOffsetY(frameH);
        v.sprite.y = offsetY;
        v.label.y = offsetY - 2;
        const playing = v.sprite.playing;
        v.sprite.textures = texturesByDir[v.dir];
        if (playing) v.sprite.play();
        else v.sprite.gotoAndStop(1);
      }

      function ensureVisual(agent: AgentRow): Promise<AgentVisual> {
        const existing = visuals.get(agent.id);
        if (existing) return existing;
        const pending = buildVisual(agent).then(
          (v) => {
            // Only publish into the resolved mirror if this agent wasn't
            // removed (and its pending promise swept away) while loading.
            if (visuals.get(agent.id) === pending) {
              resolvedVisuals.set(agent.id, v);
            } else {
              v.root.destroy({ children: true });
            }
            return v;
          },
          (err) => {
            // Load failed (e.g. a transient 404 on the sprite sheet). Evict
            // this agent's cached promise so the NEXT syncAgents() rebuilds
            // it from scratch instead of forever re-awaiting a rejected
            // promise — the agent self-heals on the following sync. Only
            // evict if we still own this slot (an agent removed mid-load may
            // already have had its entry swept). Re-throw so the caller
            // treats this as "skip this agent this round".
            if (visuals.get(agent.id) === pending) {
              visuals.delete(agent.id);
            }
            throw err;
          }
        );
        visuals.set(agent.id, pending);
        return pending;
      }

      function setDir(v: AgentVisual, dir: number) {
        if (v.dir === dir) return;
        v.dir = dir;
        const playing = v.sprite.playing;
        v.sprite.textures = v.texturesByDir[dir];
        if (playing) v.sprite.play();
        else v.sprite.gotoAndStop(1);
      }

      function warnVisualLoadFailure(agent: AgentRow, err: unknown) {
        const now = Date.now();
        const last = lastVisualLoadWarnAt.get(agent.id) ?? 0;
        if (now - last < 5000) return;
        lastVisualLoadWarnAt.set(agent.id, now);
        console.warn(`[sim] visual load failed for ${agent.name}`, err);
      }

      async function syncAgents(agents: Record<string, AgentRow>) {
        for (const agent of Object.values(agents)) {
          let v: AgentVisual;
          try {
            v = await ensureVisual(agent);
          } catch (err) {
            // This agent's visual failed to load this round (ensureVisual
            // already evicted its cached promise so the next sync retries).
            // Skip ONLY this agent — the remaining agents in the roster must
            // still receive their position/status updates, so we continue
            // the loop instead of letting the throw abort it.
            warnVisualLoadFailure(agent, err);
            continue;
          }
          // Fire-and-forget: applyAppearance no-ops synchronously unless
          // the appearance key actually changed, and swallows its own
          // failures internally (falls back to whatever textures were
          // already applied) — never awaited so a slow composite can't
          // stall this agent's position/status update below.
          void applyAppearance(agent, v);
          const tx = agent.pos_x * TILE;
          const ty = agent.pos_y * TILE;
          if (tx !== v.targetX || ty !== v.targetY) {
            const dx = tx - v.targetX;
            const dy = ty - v.targetY;
            if (Math.abs(dx) >= Math.abs(dy)) {
              setDir(v, dx > 0 ? DIR_RIGHT : DIR_LEFT);
            } else {
              setDir(v, dy > 0 ? DIR_DOWN : DIR_UP);
            }
            v.targetX = tx;
            v.targetY = ty;
            // Teleport (spawn/reconnect): snap instead of gliding.
            if (Math.abs(dx) > 2 * TILE || Math.abs(dy) > 2 * TILE) {
              v.root.x = tx;
              v.root.y = ty;
            }
          }
          if (agent.current_status !== v.status) {
            v.status = agent.current_status;
            if (v.status === "seated") setDir(v, DIR_UP); // face the desk
          }
          // Mock mode (NEXT_PUBLIC_MOCK_SNAPSHOT=1) never ticks the sim
          // forward, so all 9 seed agents stay "commuting" forever (spec
          // 07:00 kickoff) and hiding them would render an empty office —
          // not useful for UI work. Show them dimmed instead; normal
          // (live ws) mode keeps commuting agents fully hidden, since
          // there they are transiently off-floor before their door spawn.
          const isMock = useGameStore.getState().conn === "mock";
          if (v.status === "commuting" && isMock) {
            v.root.visible = true;
            v.root.alpha = 0.5;
          } else {
            v.root.visible = v.status !== "commuting";
            v.root.alpha = 1;
          }
        }
        // Remove visuals for agents that vanished from the snapshot. The
        // map is the single source of truth for every Container ever
        // built (including ones still in flight), so this sweep is
        // guaranteed to reach every addChild'd root — awaiting each
        // pending promise first means an agent removed the same instant
        // its visual finished loading still gets cleaned up correctly.
        for (const [id, pending] of visuals) {
          if (!agents[id]) {
            visuals.delete(id);
            resolvedVisuals.delete(id);
            // The pending promise may reject (the sprite sheet 404'd): that
            // failure needs no cleanup here (buildVisual never addChild'd a
            // root), but it MUST be caught or it surfaces as an unhandled
            // promise rejection.
            void pending
              .then((v) => v.root.destroy({ children: true }))
              .catch(() => {});
          }
        }
      }

      // ADR-003 D3: the character manifest can arrive AFTER an agent with a
      // custom appearance was already synced (composite attempted against
      // `characterManifest === null`, which `compositeCharacter` resolves
      // to `null` for — cached forever under that appearanceKey unless
      // evicted). Once the manifest actually lands, clear the whole cache
      // (cheap: it only ever holds a handful of distinct outfits) and
      // reset every currently-resolved visual's `appearanceKey` to a value
      // that can never equal a real key, forcing `applyAppearance` to
      // recompute on the very next `syncAgents` pass.
      function applyCharacterManifest() {
        characterTextureCache.clear();
        for (const v of resolvedVisuals.values()) v.appearanceKey = "__stale__";
        if (lastAgents) {
          void syncAgents(lastAgents).catch((err) => {
            console.error("[sim] syncAgents (character manifest arrival) failed", err);
          });
        }
      }

      // Initial state + subscription (zustand vanilla subscribe).
      const applyState = (
        layout: LayoutItemRow[],
        agents: Record<string, AgentRow>,
        editing: boolean
      ) => {
        if (layout !== lastLayout) {
          lastLayout = layout;
          drawFurniture(furnitureLayer, layout);
        }
        if (editing !== lastEditing) {
          lastEditing = editing;
          drawGrid(gridLayer, editing, mapTilesW, mapTilesH);
          if (!dragging) app!.canvas.style.cursor = editing ? "default" : "grab";
        }
        if (agents !== lastAgents) {
          lastAgents = agents;
          // Fire-and-forget: syncAgents already swallows per-agent load
          // failures, but guard the whole call so any unexpected rejection
          // can't become an unhandled promise rejection.
          void syncAgents(agents).catch((err) => {
            console.error("[sim] syncAgents failed", err);
          });
        }
      };
      // Same tab-aware condition as isEditingNow(): the grid/cursor only
      // reflect edit mode while the editor tab is fronted. Tab switches
      // update store.activeTab, which fires this subscriber, so leaving/
      // re-entering the editor tab redraws/clears the grid immediately.
      const initial = useGameStore.getState();
      applyState(
        initial.layout,
        initial.agents,
        initial.editorActive && initial.activeTab === "editor"
      );
      // Bug fix (color-block regression): the manifest fetch kicked off
      // above (`ensureFurnitureManifestLoaded`) is async, so
      // `initialFurnitureManifest` (captured immediately afterward) was
      // always null — the fetch can't have resolved yet at that point. But
      // everything between there and here (loadAndBuildMap/fetchLiveMap
      // etc.) awaits real network/decode work, which is plenty of time for
      // the manifest fetch to resolve and update the store WHILE THIS
      // COMPONENT WASN'T SUBSCRIBED YET. zustand's `subscribe()` below only
      // fires on state changes that happen AFTER it's registered, so that
      // already-applied update would otherwise be missed forever, leaving
      // `kindSprites` empty and every furniture item stuck on the flat-
      // color placeholder. Re-check the CURRENT state right before
      // subscribing — same pattern `applyState(initial...)` above already
      // uses for layout/agents/editorActive — so a manifest that arrived
      // during the gap still gets applied.
      if (initial.furnitureManifest && initial.furnitureManifest !== lastFurnitureManifest) {
        lastFurnitureManifest = initial.furnitureManifest;
        void applyFurnitureManifest(initial.furnitureManifest);
      }
      // Same "already arrived during the async gap" catch-up as the
      // furniture manifest above, for the character manifest.
      if (initial.characterManifest && initial.characterManifest !== lastCharacterManifest) {
        lastCharacterManifest = initial.characterManifest;
        applyCharacterManifest();
      }
      unsubscribe = useGameStore.subscribe((state) => {
        applyState(
          state.layout,
          state.agents,
          state.editorActive && state.activeTab === "editor"
        );
        // ADR-002 D2: a world_snapshot whose world.map_rev outran the
        // cached mapRev means /world/map changed under us — refetch and
        // rebuild mapLayer. No-op in mock mode / while already fetching /
        // when nothing actually changed (see ensureFreshMap's guard).
        void ensureFreshMap();
        // ADR-003 D2: the manifest may still be loading when this effect
        // first ran (e.g. LayoutEditorPanel's mount effect fired first and
        // its fetch hasn't resolved yet) — pick it up as soon as the store
        // has it, whichever component's `ensureFurnitureManifestLoaded`
        // call actually issued the fetch.
        if (state.furnitureManifest && state.furnitureManifest !== lastFurnitureManifest) {
          lastFurnitureManifest = state.furnitureManifest;
          void applyFurnitureManifest(state.furnitureManifest);
        }
        if (state.characterManifest && state.characterManifest !== lastCharacterManifest) {
          lastCharacterManifest = state.characterManifest;
          applyCharacterManifest();
        }
      });

      // Movement interpolation: 1 tile per tick, tick pace from store.
      app.ticker.add((ticker) => {
        const { world, speed, running } = useGameStore.getState();
        const tickMs = world ? Math.max(world.tick_ms, 1) / Math.max(speed, 1) : 1000;
        const pxPerMs = TILE / tickMs;
        // Walk-cycle rate scales with the time-control speed multiplier so
        // legs don't appear to under-cycle relative to how fast agents
        // glide across tiles at x2/x5, capped so it stays readable.
        const animSpeed = Math.min(ANIM_SPEED_BASE * Math.max(speed, 1), ANIM_SPEED_MAX);
        for (const v of resolvedVisuals.values()) {
          v.sprite.animationSpeed = animSpeed;
          const dx = v.targetX - v.root.x;
          const dy = v.targetY - v.root.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.5) {
            const step = Math.min(dist, pxPerMs * ticker.deltaMS * 1.15);
            v.root.x += (dx / dist) * step;
            v.root.y += (dy / dist) * step;
            if (!v.sprite.playing && v.status === "walking" && running) {
              v.sprite.play();
            }
          } else {
            v.root.x = v.targetX;
            v.root.y = v.targetY;
            if (v.sprite.playing) v.sprite.gotoAndStop(1);
          }
        }
      });
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
      fitViewRef.current = null;
      oneToOneViewRef.current = null;
      if (app) {
        app.destroy(true);
        app = null;
      }
    };
  }, []);

  return (
    <div className="relative">
      <div
        ref={hostRef}
        className="w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950"
      />
      <div className="pointer-events-none absolute right-2 top-2 flex gap-1">
        <button
          type="button"
          title="縮放至整張地圖"
          onClick={() => fitViewRef.current?.()}
          className="pointer-events-auto rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          適配
        </button>
        <button
          type="button"
          title="還原為 1:1 像素縮放"
          onClick={() => oneToOneViewRef.current?.()}
          className="pointer-events-auto rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          1:1
        </button>
      </div>
    </div>
  );
}
