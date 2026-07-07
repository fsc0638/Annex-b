// Zustand store: the single client-side source of truth for world state.
// world_snapshot fully replaces state (this is what makes page reload /
// reconnect restoration work); incremental events mutate it in place.

import { create } from "zustand";
import type {
  AgentRow,
  LayoutItemRow,
  ServerMsg,
  WorldMeta,
  WorkItemRow,
} from "./types";

export type ConnState = "connecting" | "open" | "closed" | "mock";

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

  setConn: (c: ConnState) => void;
  applyServerMsg: (msg: ServerMsg) => void;
  clearError: () => void;
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

  setConn: (c) => set({ conn: c }),
  clearError: () => set({ lastError: null }),

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
        case "world_paused":
          return { running: false };
        case "error":
          return { lastError: msg.message };
        default:
          return {};
      }
    }),
}));
