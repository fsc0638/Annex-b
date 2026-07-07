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
import { useGameStore } from "./store";
import { footprintOf, type AgentRow, type LayoutItemRow } from "./types";

const TILE = 32;
const MAP_W = 48;
const MAP_H = 32;

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

function drawFurniture(container: Container, layout: LayoutItemRow[]) {
  // Redraw in place rather than removeChildren() + a brand new Graphics:
  // removeChildren() only detaches the old Graphics from the display
  // list, it doesn't destroy its GPU geometry, so a fresh Container on
  // every world_snapshot leaked one GPU buffer per snapshot. A single
  // persistent Graphics reused via clear() has no such leak.
  let g = container.children[0] as Graphics | undefined;
  if (!g) {
    g = new Graphics();
    container.addChild(g);
  } else {
    g.clear();
  }
  for (const item of layout) {
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
}

export default function OfficeCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let app: Application | null = null;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      const created = new Application();
      await created.init({
        width: MAP_W * TILE,
        height: MAP_H * TILE,
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

      const mapLayer = new Container();
      const furnitureLayer = new Container();
      const agentLayer = new Container();
      app.stage.addChild(mapLayer, furnitureLayer, agentLayer);

      // ---- Static map from tmj + tileset -----------------------------
      const tmj: TmjDoc = await (await fetch("/maps/office_shell.tmj")).json();
      const tilesetUrl = new URL(
        tmj.tilesets[0].image,
        new URL("/maps/", window.location.href)
      ).pathname;
      const sheet = (await Assets.load(tilesetUrl)) as Texture;
      sheet.source.scaleMode = "nearest";
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
        const pending = buildVisual(agent).then((v) => {
          // Only publish into the resolved mirror if this agent wasn't
          // removed (and its pending promise swept away) while loading.
          if (visuals.get(agent.id) === pending) {
            resolvedVisuals.set(agent.id, v);
          } else {
            v.root.destroy({ children: true });
          }
          return v;
        });
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

      async function syncAgents(agents: Record<string, AgentRow>) {
        for (const agent of Object.values(agents)) {
          const v = await ensureVisual(agent);
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
            void pending.then((v) => v.root.destroy({ children: true }));
          }
        }
      }

      // Initial state + subscription (zustand vanilla subscribe).
      let lastLayout: LayoutItemRow[] | null = null;
      let lastAgents: Record<string, AgentRow> | null = null;
      const applyState = (layout: LayoutItemRow[], agents: Record<string, AgentRow>) => {
        if (layout !== lastLayout) {
          lastLayout = layout;
          drawFurniture(furnitureLayer, layout);
        }
        if (agents !== lastAgents) {
          lastAgents = agents;
          void syncAgents(agents);
        }
      };
      const initial = useGameStore.getState();
      applyState(initial.layout, initial.agents);
      unsubscribe = useGameStore.subscribe((state) =>
        applyState(state.layout, state.agents)
      );

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
      if (app) {
        app.destroy(true);
        app = null;
      }
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950"
    />
  );
}
