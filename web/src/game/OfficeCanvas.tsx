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
import { useGameStore } from "./store";
import { footprintOf, type AgentRow, type LayoutItemRow } from "./types";

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

const LIMEZU_FURNITURE_MANIFEST_URL =
  "/tilesets/limezu-modern-office/manifest.json";
const FURNITURE_KINDS = new Set(
  Object.keys(FURNITURE_COLORS) as LayoutItemRow["kind"][]
);
let furnitureSpriteLoadWarned = false;

type FurnitureSpriteFit = "contain" | "cover" | "stretch";

interface FurnitureSpriteManifestEntry {
  id?: string;
  label?: string;
  file?: string;
  image?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fit?: FurnitureSpriteFit;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

interface LimeZuFurnitureManifest {
  sprites?: Record<string, FurnitureSpriteManifestEntry>;
  catalog?: FurnitureSpriteManifestEntry[];
}

interface FurnitureSpriteEntry {
  texture: Texture;
  fit: FurnitureSpriteFit;
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface FurnitureSpriteCatalog {
  byKind: Partial<Record<LayoutItemRow["kind"], FurnitureSpriteEntry>>;
  byId: Record<string, FurnitureSpriteEntry>;
}

interface AgentVisual {
  root: Container;
  sprite: AnimatedSprite;
  texturesByDir: Texture[][];
  dir: number;
  targetX: number;
  targetY: number;
  status: string;
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

function isFurnitureKind(value: string): value is LayoutItemRow["kind"] {
  return FURNITURE_KINDS.has(value as LayoutItemRow["kind"]);
}

function warnFurnitureSpriteLoadFailure(err: unknown) {
  if (furnitureSpriteLoadWarned) return;
  furnitureSpriteLoadWarned = true;
  console.warn(
    "[sim] LimeZu furniture manifest unavailable; using generated placeholders",
    err
  );
}

async function loadFurnitureSprites(): Promise<FurnitureSpriteCatalog | null> {
  try {
    const response = await fetch(LIMEZU_FURNITURE_MANIFEST_URL, {
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while loading furniture manifest`);
    }

    const manifest = (await response.json()) as LimeZuFurnitureManifest;
    const sprites = manifest.sprites ?? {};
    const textureCache = new Map<string, Promise<Texture>>();
    const catalog: FurnitureSpriteCatalog = { byKind: {}, byId: {} };

    const loadSpriteEntry = async (
      spriteDef: FurnitureSpriteManifestEntry
    ): Promise<FurnitureSpriteEntry | null> => {
      if (!spriteDef.image) return null;
      let pendingTexture = textureCache.get(spriteDef.image);
      if (!pendingTexture) {
        pendingTexture = Assets.load(spriteDef.image).then((texture) => {
          const loaded = texture as Texture;
          loaded.source.scaleMode = "nearest";
          return loaded;
        });
        textureCache.set(spriteDef.image, pendingTexture);
      }
      const baseTexture = await pendingTexture;
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
    };

    for (const [kind, spriteDef] of Object.entries(sprites)) {
      if (!isFurnitureKind(kind) || !spriteDef.image) continue;
      const spriteEntry = await loadSpriteEntry(spriteDef);
      if (spriteEntry) catalog.byKind[kind] = spriteEntry;
    }

    for (const material of manifest.catalog ?? []) {
      if (!material.id && !material.image) continue;
      const spriteEntry = await loadSpriteEntry(material);
      if (!spriteEntry) continue;
      if (material.id) catalog.byId[material.id] = spriteEntry;
      if (material.image) catalog.byId[material.image] = spriteEntry;
    }

    return Object.keys(catalog.byKind).length > 0 ||
      Object.keys(catalog.byId).length > 0
      ? catalog
      : null;
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

function spriteEntryForItem(
  item: LayoutItemRow,
  sprites: FurnitureSpriteCatalog
): FurnitureSpriteEntry | undefined {
  const spriteMeta = readSpriteMeta(item.meta);
  if (spriteMeta?.id && sprites.byId[spriteMeta.id]) {
    return sprites.byId[spriteMeta.id];
  }
  if (spriteMeta?.image && sprites.byId[spriteMeta.image]) {
    return sprites.byId[spriteMeta.image];
  }
  return sprites.byKind[item.kind];
}

function readSpriteMeta(meta: unknown): { id?: string; image?: string } | null {
  if (!isPlainRecord(meta)) return null;
  const sprite = meta.sprite;
  if (!isPlainRecord(sprite)) return null;
  const id = typeof sprite.id === "string" ? sprite.id : undefined;
  const image = typeof sprite.image === "string" ? sprite.image : undefined;
  return id || image ? { id, image } : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function drawFurniture(
  container: Container,
  layout: LayoutItemRow[],
  sprites?: FurnitureSpriteCatalog | null
) {
  // Keep one persistent Graphics for fallback placeholders. Sprite children are
  // destroyed on each layout redraw, while the Graphics is cleared in place to
  // avoid leaking GPU geometry during frequent world_snapshot updates.
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
    const spriteDef = sprites ? spriteEntryForItem(item, sprites) : undefined;
    if (spriteDef) {
      addFurnitureSprite(spriteLayer, spriteDef, item);
    } else {
      drawFurniturePlaceholder(g, item);
    }
  }
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

      const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

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
        zoom = clampZoom(
          Math.min(VIEWPORT_W / (mapTilesW * TILE), VIEWPORT_H / (mapTilesH * TILE))
        );
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
        return useGameStore.getState().world?.status === "editing";
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

      let furnitureSprites: FurnitureSpriteCatalog | null = null;
      let lastLayout: LayoutItemRow[] | null = null;
      let lastAgents: Record<string, AgentRow> | null = null;
      let lastEditing = false;

      void loadFurnitureSprites().then((sprites) => {
        if (cancelled) return;
        furnitureSprites = sprites;
        if (lastLayout) {
          drawFurniture(furnitureLayer, lastLayout, furnitureSprites);
        }
      });

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

      async function buildVisual(agent: AgentRow): Promise<AgentVisual> {
        const sheetTex = (await Assets.load(
          `/sprites/agents/${agent.sprite_key}.png`
        )) as Texture;
        sheetTex.source.scaleMode = "nearest";
        const texturesByDir = sliceSpriteSheet(sheetTex);
        const sprite = new AnimatedSprite(texturesByDir[DIR_DOWN]);
        sprite.animationSpeed = ANIM_SPEED_BASE;
        sprite.gotoAndStop(1);
        const label = new Text({ text: agent.name, style: labelStyle });
        label.anchor.set(0.5, 1);
        label.x = TILE / 2;
        label.y = -2;
        const root = new Container();
        root.addChild(sprite, label);
        root.visible = false;
        agentLayer.addChild(root);
        const visual: AgentVisual = {
          root,
          sprite,
          texturesByDir,
          dir: DIR_DOWN,
          targetX: agent.pos_x * TILE,
          targetY: agent.pos_y * TILE,
          status: agent.current_status,
        };
        root.x = visual.targetX;
        root.y = visual.targetY;
        return visual;
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

      // Initial state + subscription (zustand vanilla subscribe).
      const applyState = (
        layout: LayoutItemRow[],
        agents: Record<string, AgentRow>,
        editing: boolean
      ) => {
        if (layout !== lastLayout) {
          lastLayout = layout;
          drawFurniture(furnitureLayer, layout, furnitureSprites);
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
      const initial = useGameStore.getState();
      applyState(initial.layout, initial.agents, initial.world?.status === "editing");
      unsubscribe = useGameStore.subscribe((state) => {
        applyState(state.layout, state.agents, state.world?.status === "editing");
        // ADR-002 D2: a world_snapshot whose world.map_rev outran the
        // cached mapRev means /world/map changed under us — refetch and
        // rebuild mapLayer. No-op in mock mode / while already fetching /
        // when nothing actually changed (see ensureFreshMap's guard).
        void ensureFreshMap();
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
