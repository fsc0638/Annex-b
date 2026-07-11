// Zustand store: the single client-side source of truth for world state.
// world_snapshot fully replaces state (this is what makes page reload /
// reconnect restoration work); incremental events mutate it in place.

import { create } from "zustand";
import type {
  AgentRow,
  LayoutItemRow,
  LayoutValidation,
  ServerMsg,
  WorldMeta,
  WorkItemRow,
} from "./types";

export type ConnState = "connecting" | "open" | "closed" | "mock";

/** The main shell's three tabs (app/page.tsx). Mirrored into the store so
 * OfficeCanvas — whose camera handlers live outside React's render tree —
 * can make the edit-mode camera lock tab-aware: the cyan grid + wheel/drag
 * no-op only apply while the editor tab itself is fronted. */
export type AppTab = "monitor" | "editor" | "agents";

export interface GameState {
  conn: ConnState;
  world: WorldMeta | null;
  agents: Record<string, AgentRow>;
  layout: LayoutItemRow[];
  workItems: WorkItemRow[];
  running: boolean;
  speed: number;
  /** Last per-client error message from the server (UI toast). */
  lastError: string | null;
  /** Result of the layout editor's last local-preview apply or save
   * round-trip (LayoutEditorPanel), surfaced as inline errors/warnings. */
  layoutValidation: LayoutValidation | null;

  /** Last TMJ object successfully fetched from `GET /api/v1/world/map`
   * (live mode) — `null` until OfficeCanvas's first fetch resolves. Mock
   * mode never populates this (it loads /maps/office_shell.tmj directly). */
  mapTmj: unknown | null;
  /** `map_rev` the cached `mapTmj` corresponds to. Defaults to `1` (the
   * engine's own initial value) so a fresh store compares equal to a
   * snapshot that hasn't changed the map yet. */
  mapRev: number;

  /** Client-local "the layout editor is open" flag (W1 fix). This is
   * DELIBERATELY not derived from `world.status` — a `world_snapshot` can
   * arrive at any time (another client's action, a PATCH from curl, a
   * reconnect) and fully replaces `world`, which used to silently flip an
   * `editing` derived-from-status flag back to false and (via
   * LayoutEditorPanel's cleanup effect) wipe an in-progress unsaved draft.
   * `applyServerMsg` must NEVER write this field — only
   * `setEditorActive` (called explicitly by LayoutEditorPanel on
   * enter/cancel/save-success) may change it. */
  editorActive: boolean;
  /** Increments once per processed `world_snapshot`. Lets LayoutEditorPanel
   * detect "a snapshot landed while I have an unsaved draft" (to show a
   * staleness notice) without touching `editorActive`. */
  worldSnapshotSeq: number;
  /** Which main-shell tab is currently fronted (mirrors app/page.tsx's own
   * tab state via `setActiveTab`). Client-local UI state:
   * `applyServerMsg` must NEVER write this field. Switching tabs does not
   * touch `editorActive` either — an open draft survives tab switches;
   * this flag only scopes OfficeCanvas's grid/camera-lock to the editor
   * tab being the one actually on screen. */
  activeTab: AppTab;

  setConn: (c: ConnState) => void;
  applyServerMsg: (msg: ServerMsg) => void;
  clearError: () => void;
  /** Called by OfficeCanvas after a successful `GET /api/v1/world/map`. */
  setMap: (tmj: unknown, rev: number) => void;
  /** Called only by LayoutEditorPanel — see `editorActive` above. */
  setEditorActive: (active: boolean) => void;
  /** Called only by app/page.tsx's tab bar — see `activeTab` above. */
  setActiveTab: (tab: AppTab) => void;
}

export const useGameStore = create<GameState>((set) => ({
  conn: "connecting",
  world: null,
  agents: {},
  layout: [],
  workItems: [],
  running: false,
  speed: 1,
  lastError: null,
  layoutValidation: null,
  mapTmj: null,
  mapRev: 1,
  editorActive: false,
  worldSnapshotSeq: 0,
  activeTab: "monitor",

  setConn: (c) => set({ conn: c }),
  clearError: () => set({ lastError: null }),
  setMap: (tmj, rev) => set({ mapTmj: tmj, mapRev: rev }),
  setEditorActive: (active) => set({ editorActive: active }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  applyServerMsg: (msg) =>
    set((state) => {
      switch (msg.type) {
        case "world_snapshot": {
          const agents: Record<string, AgentRow> = {};
          for (const a of msg.agents) agents[a.id] = a;
          return {
            world: msg.world,
            agents,
            layout: msg.layout,
            workItems: msg.work_items ?? [],
            running: msg.world.status === "running",
            speed: msg.world.speed ?? 1,
            // NOTE: `editorActive` is intentionally absent from this
            // return — a world_snapshot must never touch it (see the
            // field's doc comment above). worldSnapshotSeq bumps so
            // LayoutEditorPanel can notice a snapshot landed mid-draft.
            worldSnapshotSeq: state.worldSnapshotSeq + 1,
          };
        }
        case "layout_updated": {
          const agents: Record<string, AgentRow> = {};
          for (const a of msg.agents) agents[a.id] = a;
          return {
            layout: msg.layout,
            agents,
            layoutValidation: msg.validation,
          };
        }
        case "tick": {
          if (!state.world) return {};
          return {
            world: {
              ...state.world,
              sim_day: msg.sim_day,
              sim_clock_sec: msg.sim_clock_sec,
            },
            running: true,
            speed: msg.speed,
          };
        }
        case "agent_moved": {
          const agent = state.agents[msg.agent_id];
          if (!agent) return {};
          return {
            agents: {
              ...state.agents,
              [msg.agent_id]: { ...agent, pos_x: msg.x, pos_y: msg.y },
            },
          };
        }
        case "agent_status": {
          const agent = state.agents[msg.agent_id];
          if (!agent) return {};
          return {
            agents: {
              ...state.agents,
              [msg.agent_id]: { ...agent, current_status: msg.status },
            },
          };
        }
        case "agent_stuck": {
          // Purely observational: the server keeps current_status as
          // "walking" while a walker fails to reroute, so we must NOT touch
          // any rendered agent state here (doing so would diverge the client
          // from the server and freeze the walk animation). Just surface it
          // loudly for debugging.
          console.warn(
            `[sim] agent ${msg.agent_id} is stuck (reroute failing); still walking on the server`
          );
          return {};
        }
        case "world_paused":
          return { running: false };
        case "error":
          return { lastError: msg.message };
        default:
          return {};
      }
    }),
}));
